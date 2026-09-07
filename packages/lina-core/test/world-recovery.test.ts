import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/index.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
const stores: WorldStore[] = [];
const limits = { maxChars: 6000, maxFacts: 10, maxEvents: 10 };
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-world-recovery-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path);
	stores.push(store);
	store.create(worldDefinition());
	return { path, store };
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("failure after event insertion rolls back both receipt and checkpoint", () => {
	const { store, path } = fixture();
	const fault = new DatabaseSync(path);
	try {
		fault.exec(
			"CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON worlds BEGIN SELECT RAISE(ABORT, 'synthetic disk write failure'); END;",
		);
		expect(() => store.accept(worldActivity())).toThrow(
			"synthetic disk write failure",
		);
		expect(store.snapshot("test-world").revision).toBe(0);
		expect(store.context("test-world", "lina", limits).events).toEqual([]);
		fault.exec("DROP TRIGGER reject_checkpoint");
		expect(store.accept(worldActivity()).replayed).toBe(false);
	} finally {
		fault.close();
	}
});

test("reopening fails closed on corrupt checkpoint or unsupported schema", () => {
	const { store, path } = fixture();
	store.accept(worldActivity());
	store.close();
	const raw = new DatabaseSync(path);
	try {
		raw.exec(
			"UPDATE worlds SET state_json = json_set(state_json, '$.simulationTime', 999)",
		);
		expect(() => new WorldStore(path)).toThrow("checkpoint");
		raw.exec("PRAGMA user_version = 999");
		expect(() => new WorldStore(path)).toThrow("schema version");
	} finally {
		raw.close();
	}
});

test.each(["9007199254740992", "9223372036854775807"])(
	"startup rejects an event revision outside the supported range: %s",
	(revision) => {
		const { store, path } = fixture();
		const accepted = store.accept(worldActivity()).event;
		store.close();
		const raw = new DatabaseSync(path);
		try {
			// Keep the valid event/checkpoint; this extra corrupt row used to be
			// filtered out by recovery's MAX_SAFE_INTEGER upper bound.
			raw
				.prepare(
					"INSERT INTO world_events (world_id, idempotency_key, revision, event_json) VALUES (?, ?, CAST(? AS INTEGER), ?)",
				)
				.run(
					"test-world",
					"out-of-range",
					revision,
					JSON.stringify({ ...accepted, idempotencyKey: "out-of-range" }),
				);
		} finally {
			raw.close();
		}
		expect(() => {
			const reopened = new WorldStore(path);
			stores.push(reopened);
		}).toThrow();
	},
);

test("constructor preserves the original busy error when a writer holds the database", () => {
	const { store, path } = fixture();
	store.close();
	const writer = new DatabaseSync(path);
	try {
		writer.exec("BEGIN IMMEDIATE");
		expect(() => {
			new WorldStore(path);
		}).toThrow(/locked|busy/i);
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
	}
}, 10000);

test("a committed event survives a writer process killed before graceful close", async () => {
	const { store, path } = fixture();
	store.close();
	const modulePath = new URL("../src/world/index.ts", import.meta.url).pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { WorldStore } from ${JSON.stringify(modulePath)};
		const store = new WorldStore(${JSON.stringify(path)});
		const result = store.accept(${JSON.stringify(worldActivity())});
		console.log(JSON.stringify(result));
		await Bun.stdin.text();
	`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		const output = await reader.read();
		expect(new TextDecoder().decode(output.value)).toContain(
			'"replayed":false',
		);
		reader.releaseLock();
		child.kill("SIGKILL");
		await child.exited;
		const recovered = new WorldStore(path);
		stores.push(recovered);
		expect(recovered.snapshot("test-world").revision).toBe(1);
		expect(recovered.accept(worldActivity()).replayed).toBe(true);
		expect(
			recovered.context("test-world", "mira", limits).facts.map((f) => f.id),
		).toEqual(["bell", "whisper"]);
	} finally {
		child.kill();
		await child.exited;
	}
});

test("simultaneous processes accept exactly one proposal at the same revision", async () => {
	const { store, path } = fixture();
	store.close();
	const modulePath = new URL("../src/world/index.ts", import.meta.url).pathname;
	const children = ["one", "two"].map((key) =>
		Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
		import { WorldStore } from ${JSON.stringify(modulePath)};
		const store = new WorldStore(${JSON.stringify(path)});
		console.log("ready");
		await Bun.stdin.text();
		try { store.accept(${JSON.stringify(worldActivity({ idempotencyKey: key }))}); console.log("accepted"); }
		catch (error) { console.log(error.message); }
		finally { store.close(); }
	`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		),
	);
	try {
		await Promise.all(
			children.map(async (child) => {
				const reader = child.stdout.getReader();
				const ready = await reader.read();
				expect(new TextDecoder().decode(ready.value)).toContain("ready");
				reader.releaseLock();
			}),
		);
		for (const child of children) {
			child.stdin.write("go");
			child.stdin.end();
		}
		const output = await Promise.all(
			children.map(async (child) => {
				let text = "";
				const decoder = new TextDecoder();
				for await (const chunk of child.stdout)
					text += decoder.decode(chunk, { stream: true });
				text += decoder.decode();
				expect(await child.exited).toBe(0);
				return text.trim();
			}),
		);
		expect(output.sort()).toEqual(["World revision conflict", "accepted"]);
		const recovered = new WorldStore(path);
		stores.push(recovered);
		expect(recovered.snapshot("test-world").revision).toBe(1);
		expect(recovered.context("test-world", "lina", limits).events).toHaveLength(
			1,
		);
	} finally {
		for (const child of children) child.kill();
		await Promise.all(children.map((c) => c.exited));
	}
});
