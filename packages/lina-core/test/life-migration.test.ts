import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/index.ts";
import {
	eventId,
	initialSnapshot,
	transition,
} from "../src/world/transition.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

// The exact shipped v1 schema is deliberately independent of the new initializer.
const V1_SCHEMA = `
CREATE TABLE worlds (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, state_json TEXT NOT NULL) STRICT;
CREATE TABLE world_events (world_id TEXT NOT NULL REFERENCES worlds(id), idempotency_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), event_json TEXT NOT NULL, PRIMARY KEY(world_id, idempotency_key), UNIQUE(world_id, revision)) STRICT;
PRAGMA application_id = 1280791089;
PRAGMA user_version = 1;
`;
const roots: string[] = [];
const stores: WorldStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
	const root = mkdtempSync(join(tmpdir(), "lina-life-migration-"));
	roots.push(root);
	return join(root, "world.sqlite");
}

function legacyFixture(path: string) {
	const definition = worldDefinition();
	const proposal = worldActivity();
	const snapshot = transition(initialSnapshot(definition), proposal);
	const { definition: _definition, ...state } = snapshot;
	const event = {
		...proposal,
		id: eventId(definition.id, snapshot.revision),
		revision: snapshot.revision,
		acceptedAt: "2026-01-01T00:00:00.000Z",
		origin: "fictional",
		definitionVersion: definition.version,
	};
	const eventJson = JSON.stringify(event);
	const stateJson = JSON.stringify(state);
	const raw = new DatabaseSync(path);
	try {
		raw.exec(V1_SCHEMA);
		raw
			.prepare("INSERT INTO worlds VALUES (?, ?, ?)")
			.run(definition.id, JSON.stringify(definition), stateJson);
		raw
			.prepare("INSERT INTO world_events VALUES (?, ?, ?, ?)")
			.run(definition.id, proposal.idempotencyKey, event.revision, eventJson);
	} finally {
		raw.close();
	}
	return { definition, snapshot, eventJson, stateJson };
}

test("v1 migration preserves event bytes and starts no implicit LIFE history", () => {
	const path = databasePath();
	const before = legacyFixture(path);
	const store = new WorldStore(path);
	stores.push(store);
	expect(store.snapshot("test-world")).toEqual(before.snapshot);
	expect(store.accept(worldActivity()).replayed).toBe(true);
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 6,
		});
		expect(raw.prepare("SELECT event_json FROM world_events").get()).toEqual({
			event_json: before.eventJson,
		});
		expect(raw.prepare("SELECT state_json FROM worlds").get()).toEqual({
			state_json: before.stateJson,
		});
		expect(
			raw
				.prepare("SELECT definition_json FROM world_definition_versions")
				.get(),
		).toEqual({
			definition_json: JSON.stringify(before.definition),
		});
		expect(raw.prepare("SELECT count(*) AS n FROM life_states").get()).toEqual({
			n: 0,
		});
		expect(raw.prepare("SELECT count(*) AS n FROM life_config").get()).toEqual({
			n: 0,
		});
		expect(
			raw.prepare("SELECT count(*) AS n FROM world_bindings").get(),
		).toEqual({ n: 0 });
		expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		raw.close();
	}
	store.close();
	const reopened = new WorldStore(path);
	stores.push(reopened);
	expect(reopened.snapshot("test-world")).toEqual(before.snapshot);
});

test("new database uses v6 and records each world's immutable definition", () => {
	const path = databasePath();
	const store = new WorldStore(path);
	stores.push(store);
	store.create(worldDefinition());
	store.create(worldDefinition());
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 6,
		});
		expect(
			raw.prepare("SELECT count(*) AS n FROM world_definition_versions").get(),
		).toEqual({ n: 1 });
		expect(
			raw
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'",
				)
				.all(),
		).toHaveLength(26);
	} finally {
		raw.close();
	}
});

test.each(["9007199254740992", "9223372036854775807"])(
	"invalid v1 event number %s rejects without partially migrating",
	(revision) => {
		const path = databasePath();
		const before = legacyFixture(path);
		const raw = new DatabaseSync(path);
		try {
			raw
				.prepare(
					"INSERT INTO world_events VALUES (?, ?, CAST(? AS INTEGER), ?)",
				)
				.run("test-world", "overflow", revision, before.eventJson);
			expect(() => new WorldStore(path)).toThrow();
			expect(raw.prepare("PRAGMA user_version").get()).toEqual({
				user_version: 1,
			});
			expect(
				raw
					.prepare("SELECT name FROM sqlite_schema WHERE name = 'life_states'")
					.all(),
			).toEqual([]);
			expect(raw.prepare("SELECT state_json FROM worlds").get()).toEqual({
				state_json: before.stateJson,
			});
		} finally {
			raw.close();
		}
	},
);

test("failed migration rolls back new tables and leaves the original v1 file readable", () => {
	const path = databasePath();
	const before = legacyFixture(path);
	const original = DatabaseSync.prototype.exec;
	const fault = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			if (/PRAGMA user_version\s*=\s*2/.test(sql))
				throw Error("synthetic migration write failure");
			return original.call(this, sql);
		},
	);
	try {
		expect(() => new WorldStore(path)).toThrow(
			"synthetic migration write failure",
		);
	} finally {
		fault.mockRestore();
	}
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 1,
		});
		expect(
			raw
				.prepare("SELECT name FROM sqlite_schema WHERE name = 'life_states'")
				.all(),
		).toEqual([]);
		expect(raw.prepare("SELECT event_json FROM world_events").get()).toEqual({
			event_json: before.eventJson,
		});
	} finally {
		raw.close();
	}
	const recovered = new WorldStore(path);
	stores.push(recovered);
	expect(recovered.snapshot("test-world")).toEqual(before.snapshot);
});

test("unknown versions and extra schema objects are rejected without deletion", () => {
	const path = databasePath();
	legacyFixture(path);
	const raw = new DatabaseSync(path);
	try {
		raw.exec("PRAGMA user_version = 999");
		expect(() => new WorldStore(path)).toThrow("schema version");
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 999,
		});
		raw.exec("PRAGMA user_version = 1; CREATE TABLE unrelated(value TEXT)");
		expect(() => new WorldStore(path)).toThrow("schema");
		expect(
			raw
				.prepare("SELECT name FROM sqlite_schema WHERE name = 'unrelated'")
				.all(),
		).toHaveLength(1);
	} finally {
		raw.close();
	}
});
