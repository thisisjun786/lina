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
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../src/session-binding.ts";
import { DurableStore } from "../src/store.ts";
import { Fixture } from "./fixture.ts";

describe("filesystem ownership boundaries", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("rejects symlink roots and ancestor directories", () => {
		const link = join(fixture.dir, "link");
		symlinkSync(fixture.binding.workspace, link);
		for (const root of [link, join(link, "nested")]) {
			expect(() =>
				acquireSessionLease(root, "lina", fixture.binding.workspace),
			).toThrow();
		}
	});

	it("rejects symlink manifests, lease databases and SQLite sidecars", () => {
		mkdirSync(fixture.root);
		const sentinel = join(fixture.dir, "sentinel");
		writeFileSync(sentinel, "keep");
		for (const name of [
			"binding.json",
			"owner.sqlite",
			"owner.sqlite-journal",
			"owner.sqlite-wal",
			"owner.sqlite-shm",
		]) {
			const link = join(fixture.root, name);
			symlinkSync(sentinel, link);
			expect(() =>
				acquireSessionLease(fixture.root, "lina", fixture.binding.workspace),
			).toThrow();
			expect(readFileSync(sentinel, "utf8")).toBe("keep");
			rmSync(link);
		}
	});

	it("rejects nonregular roots, manifests, DB files and transcripts", () => {
		writeFileSync(fixture.root, "keep");
		expect(() =>
			acquireSessionLease(fixture.root, "lina", fixture.binding.workspace),
		).toThrow();
		rmSync(fixture.root);
		mkdirSync(fixture.root);
		for (const name of ["binding.json", "owner.sqlite"]) {
			const target = join(fixture.root, name);
			mkdirSync(target);
			expect(() =>
				acquireSessionLease(fixture.root, "lina", fixture.binding.workspace),
			).toThrow();
			rmSync(target, { recursive: true });
		}
		expect(() =>
			acquireTranscriptLease(fixture.root, "lina", fixture.binding.workspace),
		).toThrow();
		expect(() => new DurableStore(fixture.root, fixture.binding)).toThrow();
	});

	it("rejects symlink transcript and store targets without changing their destination", () => {
		const link = join(fixture.dir, "transcript-link");
		symlinkSync(fixture.binding.sessionFile, link);
		expect(() =>
			acquireTranscriptLease(link, "lina", fixture.binding.workspace),
		).toThrow();
		expect(() => new DurableStore(link, fixture.binding)).toThrow();
		expect(readFileSync(fixture.binding.sessionFile, "utf8")).toBe("");
	});

	it("rejects hardlinked transcripts so alternate paths cannot bypass ownership", () => {
		const alias = join(fixture.dir, "alias.jsonl");
		linkSync(fixture.binding.sessionFile, alias);
		for (const file of [alias, fixture.binding.sessionFile]) {
			expect(() =>
				acquireTranscriptLease(file, "lina", fixture.binding.workspace),
			).toThrow();
		}
	});

	it("rejects store and transcript lease symlink sidecars before SQLite touches them", () => {
		const sentinel = join(fixture.dir, "sentinel");
		writeFileSync(sentinel, "keep");
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			const target = `${fixture.file}${suffix}`;
			symlinkSync(sentinel, target);
			expect(() => fixture.store()).toThrow();
			expect(readFileSync(sentinel, "utf8")).toBe("keep");
			rmSync(target);
		}
		symlinkSync(sentinel, `${fixture.binding.sessionFile}.lina-lease.sqlite`);
		expect(() =>
			acquireTranscriptLease(
				fixture.binding.sessionFile,
				"lina",
				fixture.binding.workspace,
			),
		).toThrow();
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});
});
