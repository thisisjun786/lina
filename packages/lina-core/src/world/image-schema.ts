import type { DatabaseSync } from "node:sqlite";
import { IMAGE_ACCOUNTING_SCHEMA } from "./image-accounting.ts";
import { IMAGE_ATTEMPTS_SCHEMA } from "./image-attempts.ts";
import { IMAGE_INTENTS_SCHEMA } from "./image-intents.ts";
import { IMAGE_POLICIES_SCHEMA } from "./image-policies.ts";
import { IMAGE_PUBLICATION_SCHEMA } from "./image-publication.ts";

export const IMAGE_SCHEMA = `
CREATE TABLE life_image_settings_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,revision)
) STRICT;
CREATE TABLE life_image_settings (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), digest TEXT NOT NULL,
 FOREIGN KEY(world_id,revision) REFERENCES life_image_settings_history(world_id,revision)
) STRICT;
${IMAGE_POLICIES_SCHEMA}
${IMAGE_INTENTS_SCHEMA}
${IMAGE_ATTEMPTS_SCHEMA}
${IMAGE_ACCOUNTING_SCHEMA}
${IMAGE_PUBLICATION_SCHEMA}
`;

/** The WorldStore migration transaction audits the complete schema7 graph first. */
export function migrateWorldV7(db: DatabaseSync): void {
	db.exec(IMAGE_SCHEMA);
	db.exec("PRAGMA user_version=8");
}
