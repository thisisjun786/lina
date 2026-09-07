import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../src/control/index.ts";
import { ControlFixture } from "./control-fixture.ts";

describe("control storage ownership and corruption", () => {
	let f: ControlFixture;
	beforeEach(() => {
		f = new ControlFixture();
	});
	afterEach(() => f.close());

	it.each(["botId", "sessionId", "sessionFile", "workspace"] as const)(
		"rejects foreign %s binding without rewriting existing records",
		(key) => {
			const a = f.pending();
			const before = f.controls.snapshot();
			const binding = {
				...f.binding,
				[key]:
					key === "workspace"
						? f.dir
						: key === "sessionFile"
							? join(f.dir, "other.jsonl")
							: "other",
			};
			expect(() => new ControlStore(f.controlFile, binding)).toThrow(/foreign/);
			expect(f.controls.snapshot()).toEqual(before);
			expect(f.controls.approval(a.id)?.state).toBe("pending");
		},
	);

	it("rejects invalid binding before creating a database", () => {
		const file = join(f.dir, "invalid.sqlite");
		expect(
			() => new ControlStore(file, { ...f.binding, workspace: "relative" }),
		).toThrow();
		expect(() => readFileSync(file)).toThrow();
	});

	it.each([
		"PRAGMA user_version = 99",
		"CREATE TABLE foreign_table (id INTEGER)",
		"DROP INDEX pending_approvals",
		"UPDATE meta SET value = 'bad' WHERE key = 'revision'",
		"UPDATE meta SET value = '9007199254740992' WHERE key = 'revision'",
		"DELETE FROM meta WHERE key = 'binding'",
		"INSERT INTO meta VALUES ('foreign', 'x')",
	])("rejects incompatible schema/metadata: %s", (sql) => {
		f.controls.close();
		const db = new DatabaseSync(f.controlFile);
		db.exec(sql);
		db.close();
		expect(() => new ControlStore(f.controlFile, f.binding)).toThrow();
	});

	it.each([
		"UPDATE approvals SET inputDigest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
		"UPDATE approvals SET inputJson = '{\"a\":2}'",
		"UPDATE approvals SET expiresAt = 9007199254740992",
		"UPDATE tools SET inputPreview = printf('%3000s', 'x')",
		"UPDATE tools SET createdAt = 'not-time'",
		"UPDATE tools SET state = 'ready'",
	])("rejects corrupt authority or record data: %s", (sql) => {
		f.pending();
		f.controls.close();
		const db = new DatabaseSync(f.controlFile);
		db.exec(`PRAGMA ignore_check_constraints = ON; ${sql}`);
		db.close();
		expect(() => new ControlStore(f.controlFile, f.binding)).toThrow();
	});

	it("rejects malformed files and existing unrelated databases without adoption", () => {
		const file = join(f.dir, "unrelated.sqlite");
		const db = new DatabaseSync(file);
		db.exec("CREATE TABLE existing (value TEXT)");
		db.close();
		expect(() => new ControlStore(file, f.binding)).toThrow();
		const corrupt = join(f.dir, "corrupt.sqlite");
		writeFileSync(corrupt, "not SQLite");
		expect(() => new ControlStore(corrupt, f.binding)).toThrow();
		expect(readFileSync(corrupt, "utf8")).toBe("not SQLite");
	});

	it("reuses safe path checks for symlink/hardlink targets and sidecars", () => {
		const sentinel = join(f.dir, "sentinel");
		writeFileSync(sentinel, "preserved");
		const file = join(f.dir, "candidate.sqlite");
		for (const suffix of ["", "-wal", "-shm", "-journal"]) {
			symlinkSync(sentinel, `${file}${suffix}`);
			expect(() => new ControlStore(file, f.binding)).toThrow();
			expect(readFileSync(sentinel, "utf8")).toBe("preserved");
			rmSync(`${file}${suffix}`);
		}
		linkSync(sentinel, file);
		expect(() => new ControlStore(file, f.binding)).toThrow();
		rmSync(file);
		const ancestor = join(f.dir, "link");
		symlinkSync(f.binding.workspace, ancestor);
		expect(
			() => new ControlStore(join(ancestor, "store.sqlite"), f.binding),
		).toThrow();
		mkdirSync(file);
		expect(() => new ControlStore(file, f.binding)).toThrow();
	});

	it("refuses revision overflow and rolls back the entire mutation", () => {
		const before = f.controls.snapshot().tools;
		const db = new DatabaseSync(f.controlFile);
		db.exec(
			"UPDATE meta SET value = '9007199254740991' WHERE key = 'revision'",
		);
		db.close();
		expect(() => f.tool()).toThrow(/revision/);
		expect(f.controls.snapshot().tools).toEqual(before);
	});

	it("recovers after reopening while retaining historical allowed decisions", () => {
		const a = f.pending();
		f.controls.decide(a.id, a.inputDigest, "allowed");
		const pending = f.pending();
		f.controls.close();
		const reopened = f.keep(
			new ControlStore(f.controlFile, f.binding, { now: f.now }),
		);
		reopened.recover();
		expect(reopened.approval(a.id)?.state).toBe("allowed");
		expect(reopened.tool(a.toolRunId)?.state).toBe("interrupted");
		expect(reopened.approval(pending.id)?.state).toBe("expired");
	});

	it("orders recent decisions by decision time rather than original request age", () => {
		const oldest = f.pending();
		for (let i = 0; i < 12; i++) {
			const a = f.pending();
			f.controls.decide(a.id, a.inputDigest, "denied");
		}
		f.controls.decide(oldest.id, oldest.inputDigest, "allowed");
		expect(f.controls.snapshot().approvals[0]?.id).toBe(oldest.id);
	});
});
