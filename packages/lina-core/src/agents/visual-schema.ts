export const AGENT_VISUAL_SCHEMA = `
CREATE TABLE agent_visuals (agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id), revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
CREATE TABLE agent_visual_history (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), revision INTEGER NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, revision)) STRICT;
CREATE TABLE agent_visual_profiles (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), revision INTEGER NOT NULL, visual_revision INTEGER NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, revision)) STRICT;
CREATE TABLE agent_visual_references (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), id TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, id)) STRICT;
CREATE TABLE agent_visual_grants (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(agent_id, id)) STRICT;
CREATE TABLE agent_visual_grant_history (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), id TEXT NOT NULL, revision INTEGER NOT NULL, visual_revision INTEGER NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, id, revision)) STRICT;
CREATE TABLE agent_avatar_admissions (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), intent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, intent_id), UNIQUE(agent_id, ordinal)) STRICT;
CREATE TABLE agent_avatar_history (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), candidate_id TEXT NOT NULL, intent_id TEXT NOT NULL, attempt_id TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(agent_id, candidate_id), UNIQUE(agent_id, intent_id, attempt_id)) STRICT;
CREATE TABLE agent_avatar_receipts (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), request_key TEXT NOT NULL, kind TEXT NOT NULL, payload_digest TEXT NOT NULL, input_json TEXT NOT NULL, outcome_json TEXT NOT NULL, PRIMARY KEY(agent_id, request_key)) STRICT;
CREATE TABLE agent_avatar_authorities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), sha256 TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, revoked INTEGER NOT NULL) STRICT;
CREATE TABLE agent_avatar_legacy_sources (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), sha256 TEXT NOT NULL, source_json TEXT NOT NULL, PRIMARY KEY(agent_id, sha256)) STRICT;
CREATE TABLE agent_avatar_capacity_assets (file_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL) STRICT;
CREATE TABLE agent_avatar_capacity_reservations (reservation_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, payload_digest TEXT NOT NULL, state TEXT NOT NULL, asset_json TEXT) STRICT;
CREATE TABLE agent_avatar_capacity_state (id INTEGER PRIMARY KEY CHECK(id=1), inventoried INTEGER NOT NULL CHECK(inventoried=1)) STRICT;
`;

export const AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA = `CREATE TABLE agent_avatar_candidate_reservations (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), intent_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(agent_id, intent_id, attempt_id), FOREIGN KEY(agent_id, intent_id) REFERENCES agent_avatar_admissions(agent_id, intent_id)) STRICT;`;
