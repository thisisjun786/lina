import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStore } from "../src/store.ts";
import { entry, Fixture } from "./fixture.ts";

function bytes(path: string) {
	return existsSync(path) ? readFileSync(path) : undefined;
}

describe("readonly durable store", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("does not create missing directories or databases", () => {
		const missingRoot = join(fixture.dir, "absent", "state.sqlite");
		expect(() =>
			DurableStore.openReadonly(missingRoot, fixture.binding),
		).toThrow();
		expect(existsSync(join(fixture.dir, "absent"))).toBe(false);
	});

	it("opens an existing journal, sees later committed writes, and refuses mutations", () => {
		const writer = fixture.store();
		writer.appendEntry(entry("a1", { role: "assistant", text: "hello" }));
		const reader = fixture.keep(
			DurableStore.openReadonly(fixture.file, fixture.binding),
		);
		expect(reader.entry("a1")?.text).toBe("hello");
		expect(reader.revision()).toBe(writer.revision());
		writer.appendEntry(entry("a2", { role: "assistant", text: "later" }));
		expect(reader.entry("a2")?.text).toBe("later");
		expect(() =>
			reader.appendEntry(entry("a3", { role: "assistant", text: "nope" })),
		).toThrow(/readonly/i);
		expect(reader.entry("a3")).toBeUndefined();
		expect(writer.entry("a3")).toBeUndefined();
		const after = bytes(fixture.file);
		const afterWal = bytes(`${fixture.file}-wal`);
		expect(() =>
			reader.appendEntry(
				entry("a4", { role: "assistant", text: "still nope" }),
			),
		).toThrow(/readonly/i);
		expect(bytes(fixture.file)).toEqual(after);
		expect(bytes(`${fixture.file}-wal`)).toEqual(afterWal);
		expect(writer.entry("a1")?.text).toBe("hello");
		expect(reader.entry("a2")?.text).toBe("later");
	});

	it("rejects foreign binding, missing files, legacy schema, and corruption without rewriting bytes", () => {
		const writer = fixture.store();
		writer.appendEntry(entry("a1"));
		writer.close();
		const before = readFileSync(fixture.file);
		expect(() =>
			DurableStore.openReadonly(fixture.file, {
				...fixture.binding,
				botId: "other",
			}),
		).toThrow(/foreign/i);
		expect(readFileSync(fixture.file)).toEqual(before);
		const missing = join(fixture.dir, "missing.sqlite");
		expect(() => DurableStore.openReadonly(missing, fixture.binding)).toThrow();
		expect(existsSync(missing)).toBe(false);
		const db = new DatabaseSync(fixture.file);
		db.exec("PRAGMA user_version = 1");
		db.close();
		const legacy = readFileSync(fixture.file);
		expect(() =>
			DurableStore.openReadonly(fixture.file, fixture.binding),
		).toThrow(/migration|schema/i);
		expect(readFileSync(fixture.file)).toEqual(legacy);
		writeFileSync(fixture.file, "not-a-database");
		const corrupt = readFileSync(fixture.file);
		expect(() =>
			DurableStore.openReadonly(fixture.file, fixture.binding),
		).toThrow();
		expect(readFileSync(fixture.file)).toEqual(corrupt);
	});

	it("can reopen after the writer closes and without a shm file", () => {
		const writer = fixture.store();
		writer.appendEntry(entry("a1", { text: "kept" }));
		writer.close();
		const shm = `${fixture.file}-shm`;
		if (existsSync(shm)) rmSync(shm);
		const reader = fixture.keep(
			DurableStore.openReadonly(fixture.file, fixture.binding),
		);
		expect(reader.entry("a1")?.text).toBe("kept");
	});

	it("rejects unsafe symlink paths without creating a database", () => {
		const victim = join(fixture.dir, "victim");
		mkdirSync(victim);
		symlinkSync(victim, join(fixture.dir, "linked"));
		expect(() =>
			DurableStore.openReadonly(
				join(fixture.dir, "linked", "state.sqlite"),
				fixture.binding,
			),
		).toThrow(/unsafe/i);
	});
});
