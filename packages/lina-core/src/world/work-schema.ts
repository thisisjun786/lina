import type { DatabaseSync } from "node:sqlite";

export const WORK_SCHEMA = `
CREATE TABLE life_work_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), state_json TEXT NOT NULL CHECK(json_valid(state_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_work_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 input_id TEXT, event_json TEXT NOT NULL CHECK(json_valid(event_json)), previous_digest TEXT NOT NULL, next_digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision), UNIQUE(world_id,input_id),
 FOREIGN KEY(world_id,input_id) REFERENCES life_inputs(world_id,input_id)
) STRICT;
CREATE TABLE life_work_experiences (
 world_id TEXT NOT NULL REFERENCES worlds(id), receipt_id TEXT NOT NULL, receipt_revision INTEGER NOT NULL CHECK(receipt_revision > 0),
 agent_id TEXT NOT NULL, experience_id TEXT NOT NULL, input_id TEXT NOT NULL, life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 PRIMARY KEY(world_id,receipt_id,receipt_revision,agent_id), UNIQUE(world_id,experience_id),
 FOREIGN KEY(world_id,input_id) REFERENCES life_inputs(world_id,input_id),
 FOREIGN KEY(world_id,life_revision) REFERENCES life_commits(world_id,life_revision)
) STRICT;
CREATE TABLE life_work_ancestry (
 world_id TEXT NOT NULL REFERENCES worlds(id), subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 refs_json TEXT NOT NULL CHECK(json_valid(refs_json)), digest TEXT NOT NULL,
 life_revision INTEGER NOT NULL CHECK(life_revision > 0),
 PRIMARY KEY(world_id,subject_kind,subject_id,life_revision)
) STRICT;
`;
export function migrateWorldV5(db: DatabaseSync): void {
	db.exec(WORK_SCHEMA);
	db.exec("PRAGMA user_version=6");
}
