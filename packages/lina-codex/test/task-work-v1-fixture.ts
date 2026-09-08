export const TASK_V1_FIXTURE_SCHEMA = `
CREATE TABLE task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE tasks (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL,
 owner_agent_id TEXT NOT NULL,
 title TEXT NOT NULL,
 cwd TEXT NOT NULL,
 prompt TEXT NOT NULL,
 model TEXT,
 thread_id TEXT,
 status TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_turn_id TEXT,
 last_error TEXT,
 source TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 pending_kind TEXT,
 pending_request_id TEXT,
 notice_state TEXT NOT NULL,
 notice_key TEXT,
 known_turn_ids_json TEXT NOT NULL,
 known_message_ids_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX tasks_request_id ON tasks(request_id);
CREATE INDEX tasks_thread_id ON tasks(thread_id);
CREATE TABLE task_requests (
 request_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 digest TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES tasks(id)
) STRICT;
CREATE TABLE task_approvals (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 method TEXT NOT NULL,
 params_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES tasks(id)
) STRICT;
`;
