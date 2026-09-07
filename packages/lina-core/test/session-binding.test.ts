import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../src/session-binding.ts";
import { Fixture } from "./fixture.ts";

describe("session ownership", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("reads a fully published manifest after a crash left its staging hardlink", () => {
		const { root, binding } = fixture;
		const lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		lease.bind(binding);
		lease.close();
		linkSync(join(root, "binding.json"), join(root, ".binding-crash.tmp"));
		const reopened = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(reopened.readBinding()).toEqual(binding);
	});

	it("holds one owner for its lifetime; fixed binding survives close and pre-manifest reopen", () => {
		const { root, binding } = fixture;
		let lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(lease.root).toBe(root);
		expect(lease.readBinding()).toBeUndefined();
		expect(() =>
			acquireSessionLease(root, binding.botId, binding.workspace),
		).toThrow();
		lease.close();
		lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(lease.readBinding()).toBeUndefined();
		lease.bind(binding);
		const bytes = readFileSync(join(root, "binding.json"));
		lease.bind({ ...binding });
		expect(readFileSync(join(root, "binding.json"))).toEqual(bytes);
		expect(() => lease.bind({ ...binding, sessionId: "new" })).toThrow();
		expect(lease.readBinding()).toEqual(binding);
		lease.close();
		expect(() => lease.bind(binding)).toThrow();
		expect(() => lease.readBinding()).toThrow();
		lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(lease.readBinding()).toEqual(binding);
	});

	it("persists immutable owner identity even before any binding", () => {
		const { root, binding } = fixture;
		fixture
			.keep(acquireSessionLease(root, binding.botId, binding.workspace))
			.close();
		expect(() =>
			acquireSessionLease(root, "another-bot", binding.workspace),
		).toThrow(/owner|foreign/i);
		mkdirSync(join(fixture.dir, "other-workspace"));
		expect(() =>
			acquireSessionLease(
				root,
				binding.botId,
				join(fixture.dir, "other-workspace"),
			),
		).toThrow();
		const lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(() => lease.bind({ ...binding, botId: "foreign" })).toThrow();
		expect(lease.readBinding()).toBeUndefined();
	});

	it("excludes another state root from the same canonical transcript and preserves ownership", () => {
		const { binding } = fixture;
		fixture.keep(
			acquireSessionLease(fixture.root, binding.botId, binding.workspace),
		);
		fixture.keep(
			acquireSessionLease(
				join(fixture.dir, "other-root"),
				binding.botId,
				binding.workspace,
			),
		);
		const transcript = fixture.keep(
			acquireTranscriptLease(
				binding.sessionFile,
				binding.botId,
				binding.workspace,
			),
		);
		expect(() =>
			acquireTranscriptLease(
				binding.sessionFile,
				binding.botId,
				binding.workspace,
			),
		).toThrow();
		transcript.close();
		expect(() =>
			acquireTranscriptLease(binding.sessionFile, "foreign", binding.workspace),
		).toThrow();
		fixture.keep(
			acquireTranscriptLease(
				binding.sessionFile,
				binding.botId,
				binding.workspace,
			),
		);
	});

	it("refuses unknown lease databases unchanged", () => {
		mkdirSync(fixture.root);
		const file = join(fixture.root, "owner.sqlite");
		const db = new DatabaseSync(file);
		db.exec(
			"CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('keep')",
		);
		db.close();
		const bytes = readFileSync(file);
		expect(() =>
			acquireSessionLease(
				fixture.root,
				fixture.binding.botId,
				fixture.binding.workspace,
			),
		).toThrow();
		expect(readFileSync(file)).toEqual(bytes);
	});

	it("rejects invalid or foreign manifests without overwriting or retaining a failed lease", () => {
		const { root, binding } = fixture;
		fixture
			.keep(acquireSessionLease(root, binding.botId, binding.workspace))
			.close();
		const file = join(root, "binding.json");
		for (const data of [
			"{",
			"{}",
			JSON.stringify({ ...binding, version: 2 }),
			JSON.stringify({ ...binding, botId: "foreign" }),
		]) {
			writeFileSync(file, data);
			expect(() =>
				acquireSessionLease(root, binding.botId, binding.workspace),
			).toThrow();
			expect(readFileSync(file, "utf8")).toBe(data);
		}
		writeFileSync(file, JSON.stringify(binding));
		const lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		expect(lease.readBinding()).toEqual(binding);
	});
});
