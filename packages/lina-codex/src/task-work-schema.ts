export const TASK_WORK_SCHEMA = `
CREATE TABLE task_work_inputs (
 request_id TEXT PRIMARY KEY REFERENCES task_requests(request_id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 turn_id TEXT,
 owner_agent_id TEXT NOT NULL,
 task_revision INTEGER NOT NULL CHECK(task_revision >= 0),
 target_turn_id TEXT,
 prior_turn_ids_json TEXT NOT NULL CHECK(json_valid(prior_turn_ids_json)),
 rejected INTEGER NOT NULL CHECK(rejected IN (0,1)),
 CHECK(rejected=0 OR turn_id IS NULL)
) STRICT;
CREATE TABLE task_work_handovers (
 task_id TEXT NOT NULL REFERENCES tasks(id),
 task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
 from_owner TEXT NOT NULL,
 to_owner TEXT NOT NULL,
 turn_id TEXT,
 PRIMARY KEY(task_id,task_revision)
) STRICT;
CREATE TABLE task_work_observations (
 receipt_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 turn_id TEXT NOT NULL,
 native_status TEXT NOT NULL CHECK(native_status IN ('completed','failed','interrupted')),
 task_revision INTEGER NOT NULL CHECK(task_revision >= 0),
 attribution_sources_json TEXT NOT NULL,
 UNIQUE(task_id,turn_id)
) STRICT;
CREATE TABLE task_work_receipts (
 receipt_id TEXT NOT NULL REFERENCES task_work_observations(receipt_id),
 receipt_revision INTEGER NOT NULL CHECK(receipt_revision >= 1),
 receipt_json TEXT NOT NULL,
 PRIMARY KEY(receipt_id,receipt_revision)
) STRICT;
CREATE TABLE task_work_policies (
 receipt_id TEXT NOT NULL REFERENCES task_work_observations(receipt_id),
 policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
 policy_json TEXT NOT NULL,
 PRIMARY KEY(receipt_id,policy_revision)
) STRICT;
CREATE TABLE task_work_operations (
 request_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('confirm','correct','share')),
 digest TEXT NOT NULL,
 operation_json TEXT NOT NULL,
 result_json TEXT NOT NULL
) STRICT;
CREATE TABLE task_work_deliveries (
 delivery_id TEXT PRIMARY KEY,
 receipt_id TEXT NOT NULL REFERENCES task_work_observations(receipt_id),
 world_id TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','withheld')),
 reason TEXT
) STRICT;
CREATE TABLE task_work_delivery_attempts (
 sequence INTEGER PRIMARY KEY,
 delivery_id TEXT NOT NULL REFERENCES task_work_deliveries(delivery_id),
 status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','withheld')),
 reason TEXT
) STRICT;
`;
