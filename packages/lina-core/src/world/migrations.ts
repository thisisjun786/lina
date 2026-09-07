import type { DatabaseSync } from "node:sqlite";

/** v2 adds LIFE records without changing the shipped world event protocol. */
export const LIFE_SCHEMA = `
CREATE TABLE world_definition_versions (
 world_id TEXT NOT NULL REFERENCES worlds(id), version INTEGER NOT NULL CHECK(version > 0),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 PRIMARY KEY(world_id, version)
) STRICT;
CREATE TABLE life_config (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision)
) STRICT;
CREATE TABLE life_states (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), life_revision INTEGER NOT NULL CHECK(life_revision >= 0),
 world_revision INTEGER NOT NULL CHECK(world_revision >= 0), config_revision INTEGER NOT NULL,
 base_world_revision INTEGER NOT NULL CHECK(base_world_revision >= 0),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 FOREIGN KEY(world_id, config_revision) REFERENCES life_config(world_id, revision)
) STRICT;
CREATE TABLE life_commits (
 world_id TEXT NOT NULL, life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 world_revision INTEGER NOT NULL CHECK(world_revision > 0), idempotency_key TEXT NOT NULL,
 input_digest TEXT NOT NULL, envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
 PRIMARY KEY(world_id, life_revision), UNIQUE(world_id, world_revision), UNIQUE(world_id, idempotency_key),
 FOREIGN KEY(world_id) REFERENCES life_states(world_id),
 FOREIGN KEY(world_id, world_revision) REFERENCES world_events(world_id, revision)
) STRICT;
CREATE TABLE life_inputs (
 world_id TEXT NOT NULL REFERENCES worlds(id), input_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision >= 0), payload_digest TEXT NOT NULL,
 input_json TEXT NOT NULL CHECK(json_valid(input_json)), consumed_life_revision INTEGER,
 PRIMARY KEY(world_id, input_id),
 FOREIGN KEY(world_id, consumed_life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE life_effects (
 world_id TEXT NOT NULL, intent_id TEXT NOT NULL, life_revision INTEGER NOT NULL,
 payload_digest TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 consumer_receipt_json TEXT CHECK(consumer_receipt_json IS NULL OR json_valid(consumer_receipt_json)),
 PRIMARY KEY(world_id, intent_id),
 FOREIGN KEY(world_id, life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE world_bindings (
 agent_id TEXT PRIMARY KEY, world_id TEXT REFERENCES worlds(id),
 revision INTEGER NOT NULL CHECK(revision >= 1), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
) STRICT;
`;

/** Caller owns the constructor transaction and validates the entire v1 ledger first. */
export function migrateWorldV1(db: DatabaseSync): void {
	db.exec(LIFE_SCHEMA);
	db.exec(`
INSERT INTO world_definition_versions (world_id, version, definition_json)
SELECT id, json_extract(definition_json, '$.version'), definition_json FROM worlds;
`);
	// A failed final write must roll back both copied definitions and all new tables.
	db.exec("PRAGMA user_version = 2");
}
