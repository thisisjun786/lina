export const SOURCE_SCHEMA = `
CREATE TABLE source_exposures (
	id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE source_requests (
	request_id TEXT PRIMARY KEY REFERENCES requests(id), origin_json TEXT NOT NULL
) STRICT;
CREATE TABLE source_policies (
	request_id TEXT NOT NULL REFERENCES source_requests(request_id),
	policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
	policy_json TEXT NOT NULL, policy_digest TEXT NOT NULL,
	PRIMARY KEY(request_id, policy_revision)
) STRICT;
CREATE TABLE source_current (
	request_id TEXT PRIMARY KEY REFERENCES source_requests(request_id),
	policy_revision INTEGER NOT NULL,
	FOREIGN KEY(request_id, policy_revision) REFERENCES source_policies(request_id, policy_revision)
) STRICT;
CREATE TABLE source_entries (
	entry_id TEXT PRIMARY KEY REFERENCES entries(entry_id),
	request_id TEXT NOT NULL REFERENCES source_requests(request_id)
) STRICT;
CREATE INDEX source_entries_request ON source_entries(request_id);
`;
