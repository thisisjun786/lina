import type { DatabaseSync } from "node:sqlite";

export const AUTHORING_SCHEMA = `
CREATE TABLE world_drafts (
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;
CREATE TABLE world_draft_versions (
 draft_id TEXT NOT NULL REFERENCES world_drafts(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), digest TEXT NOT NULL,
 PRIMARY KEY(draft_id, revision)
) STRICT;
CREATE TABLE world_packs (
 world_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), effective_revision INTEGER NOT NULL CHECK(effective_revision >= 0),
 pack_json TEXT NOT NULL CHECK(json_valid(pack_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, version), UNIQUE(world_id, effective_revision),
 FOREIGN KEY(world_id, version) REFERENCES world_definition_versions(world_id, version)
) STRICT;
CREATE TABLE world_activations (
 world_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
 draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
 confirmation_json TEXT NOT NULL CHECK(json_valid(confirmation_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 PRIMARY KEY(world_id, idempotency_key),
 FOREIGN KEY(draft_id, draft_revision) REFERENCES world_draft_versions(draft_id, revision)
) STRICT;
CREATE TABLE life_runtime_config (
 world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id, revision)
) STRICT;
CREATE TABLE world_authoring_requests (
 request_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), input_digest TEXT NOT NULL,
 dispatch_owner_json TEXT CHECK(dispatch_owner_json IS NULL OR json_valid(dispatch_owner_json)),
 FOREIGN KEY(draft_id, draft_revision) REFERENCES world_draft_versions(draft_id, revision)
) STRICT;
CREATE TABLE world_author_grants (
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
 status TEXT NOT NULL CHECK(status IN ('active', 'revoked'))
) STRICT;
`;

/** Existing v2 data must be audited first within the caller's transaction. */
export function migrateWorldV2(db: DatabaseSync): void {
	db.exec(AUTHORING_SCHEMA);
	db.exec("PRAGMA user_version = 3");
}
