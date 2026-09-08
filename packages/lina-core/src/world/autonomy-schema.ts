import type { DatabaseSync } from "node:sqlite";

export const AUTONOMY_SCHEMA = `
CREATE TABLE life_schedules (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_autonomy_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 base_world_revision INTEGER NOT NULL CHECK(base_world_revision >= 0),
 base_life_revision INTEGER NOT NULL CHECK(base_life_revision >= 0),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_steps (
 world_id TEXT NOT NULL REFERENCES worlds(id), step_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 source_world_revision INTEGER NOT NULL CHECK(source_world_revision >= 0),
 source_life_revision INTEGER NOT NULL CHECK(source_life_revision >= 0),
 step_json TEXT NOT NULL CHECK(json_valid(step_json)), digest TEXT NOT NULL,
 accepted_life_revision INTEGER CHECK(accepted_life_revision IS NULL OR accepted_life_revision >= 1),
 PRIMARY KEY(world_id, step_id), UNIQUE(world_id, idempotency_key), UNIQUE(world_id, accepted_life_revision),
 FOREIGN KEY(world_id, accepted_life_revision) REFERENCES life_commits(world_id, life_revision)
) STRICT;
CREATE TABLE life_model_receipts (
 world_id TEXT NOT NULL, step_id TEXT NOT NULL, request_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, request_id), FOREIGN KEY(world_id, step_id) REFERENCES life_steps(world_id, step_id)
) STRICT;
`;

/** The caller audits all v4 data and owns the surrounding transaction. */
export function migrateWorldV4(db: DatabaseSync): void {
	db.exec(AUTONOMY_SCHEMA);
	db.exec("PRAGMA user_version = 5");
}
