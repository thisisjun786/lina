import type { DatabaseSync } from "node:sqlite";

import { PUBLICATION_ANCESTRY_SCHEMA } from "./publication-ancestry.ts";
import { PUBLICATION_CHAINS_SCHEMA } from "./publication-chains.ts";
import { PUBLICATION_CURSORS_SCHEMA } from "./publication-cursors.ts";
import { PUBLICATION_GRANTS_SCHEMA } from "./publication-grants.ts";
import { PUBLICATION_INTERACTIONS_SCHEMA } from "./publication-interactions.ts";
import { PUBLICATION_JOBS_SCHEMA } from "./publication-jobs.ts";
import { PUBLICATION_POSTS_SCHEMA } from "./publication-posts.ts";
import { PUBLICATION_REPLY_POSTS_SCHEMA } from "./publication-reply-posts.ts";
import { PUBLICATION_RUNS_SCHEMA } from "./publication-runs.ts";

export const PUBLICATION_SCHEMA = `
CREATE TABLE life_publication_settings_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,revision)
) STRICT;
CREATE TABLE life_publication_settings (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 FOREIGN KEY(world_id,revision) REFERENCES life_publication_settings_history(world_id,revision)
) STRICT;
${PUBLICATION_GRANTS_SCHEMA}
${PUBLICATION_JOBS_SCHEMA}
${PUBLICATION_RUNS_SCHEMA}
${PUBLICATION_POSTS_SCHEMA}
${PUBLICATION_CURSORS_SCHEMA}
${PUBLICATION_CHAINS_SCHEMA}
${PUBLICATION_ANCESTRY_SCHEMA}
${PUBLICATION_INTERACTIONS_SCHEMA}
${PUBLICATION_REPLY_POSTS_SCHEMA}
`;

/** The caller audits all v6 owners first and holds the migration transaction. */
export function migrateWorldV6(db: DatabaseSync): void {
	db.exec(PUBLICATION_SCHEMA);
	db.exec("PRAGMA user_version=7");
}
