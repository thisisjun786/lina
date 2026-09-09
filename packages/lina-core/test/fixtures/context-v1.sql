
CREATE TABLE context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE summaries (
	id TEXT PRIMARY KEY, text TEXT NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('model','extractive')),
	depth INTEGER NOT NULL CHECK(depth >= 0), fingerprint TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE summary_sources (
	summary_id TEXT NOT NULL REFERENCES summaries(id),
	source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','summary')),
	source_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
	PRIMARY KEY (summary_id, ordinal)
) STRICT;
CREATE TABLE active_summary (
	id INTEGER PRIMARY KEY CHECK(id = 1),
	summary_id TEXT NOT NULL REFERENCES summaries(id),
	native_entry_id TEXT NOT NULL, first_kept_entry_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;
CREATE TABLE working_state (
	id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0),
	goal TEXT NOT NULL, decisions TEXT NOT NULL, open_items TEXT NOT NULL,
	next_steps TEXT NOT NULL, source_entry_ids TEXT NOT NULL
) STRICT;
