// Exact journal schema at3ff96e3, before source provenance. Test fixture only.
export const SOURCE_JOURNAL_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE entries (
	seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
	session_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','meta')),
	text TEXT NOT NULL, preview TEXT NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
	raw_json TEXT NOT NULL, timestamp TEXT NOT NULL
) STRICT;
CREATE INDEX visible_entries ON entries(seq) WHERE role IN ('user','assistant','tool');
CREATE TABLE requests (
	id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('queued','accepted','settled','rejected','interrupted')),
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
	entry_id TEXT REFERENCES entries(entry_id)
) STRICT;
CREATE INDEX pending_requests ON requests(status) WHERE status IN ('queued','accepted');
`;
