import type { DatabaseSync } from "node:sqlite";

export const SOCIAL_SCHEMA = `
CREATE TABLE world_social_bootstraps (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), bootstrap_json TEXT NOT NULL CHECK(json_valid(bootstrap_json)), digest TEXT NOT NULL
) STRICT;
CREATE TABLE world_social_resolutions (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_id TEXT NOT NULL, request_digest TEXT NOT NULL,
 input_digest TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), result_digest TEXT,
 accepted_life_revision INTEGER CHECK(accepted_life_revision IS NULL OR accepted_life_revision >= 1),
 PRIMARY KEY(world_id, request_id), UNIQUE(world_id, accepted_life_revision),
 FOREIGN KEY(world_id, accepted_life_revision) REFERENCES life_commits(world_id, life_revision),
 CHECK((result_json IS NULL) = (result_digest IS NULL)),
 CHECK(accepted_life_revision IS NULL OR result_json IS NOT NULL)
) STRICT;
`;

/** Run only after auditing v3 data within the same outer transaction. */
export function migrateWorldV3(db: DatabaseSync): void {
	db.exec(SOCIAL_SCHEMA);
	db.exec("PRAGMA user_version = 4");
}
