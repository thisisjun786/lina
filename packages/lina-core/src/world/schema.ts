import { DatabaseSync } from "node:sqlite";
import { AUTHORING_SCHEMA, migrateWorldV2 } from "./authoring-schema.ts";
import { LIFE_SCHEMA, migrateWorldV1 } from "./migrations.ts";

import { migrateWorldV3, SOCIAL_SCHEMA } from "./social-schema.ts";

const APPLICATION_ID = 0x4c575231;
const SCHEMA_VERSION = 4;
const SCHEMA = `
CREATE TABLE worlds (id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, state_json TEXT NOT NULL) STRICT;
CREATE TABLE world_events (world_id TEXT NOT NULL REFERENCES worlds(id), idempotency_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), event_json TEXT NOT NULL, PRIMARY KEY(world_id, idempotency_key), UNIQUE(world_id, revision)) STRICT;
`;
function shape(db: DatabaseSync): string {
	return JSON.stringify(
		db
			.prepare(
				"SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
			)
			.all(),
	);
}
export function initializeWorldSchema(
	db: DatabaseSync,
	validateLegacy: () => void,
	validateV2: () => void,
	validateV3: () => void,
): void {
	const application = db.prepare("PRAGMA application_id").get() as {
		application_id: number;
	};
	const version = db.prepare("PRAGMA user_version").get() as {
		user_version: number;
	};
	const count = db
		.prepare(
			"SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
		)
		.get() as { n: number };
	if (
		count.n === 0 &&
		application.application_id === 0 &&
		version.user_version === 0
	) {
		db.exec(SCHEMA);
		db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
	} else if (
		application.application_id !== APPLICATION_ID ||
		![1, 2, 3, SCHEMA_VERSION].includes(version.user_version)
	) {
		throw Error("Unsupported world database owner or schema version");
	}
	const expected = new DatabaseSync(":memory:");
	try {
		expected.exec(SCHEMA);
		if (version.user_version >= 2) expected.exec(LIFE_SCHEMA);
		if (version.user_version >= 3) expected.exec(AUTHORING_SCHEMA);
		if (version.user_version === SCHEMA_VERSION) expected.exec(SOCIAL_SCHEMA);
		if (shape(expected) !== shape(db))
			throw Error("Unsupported world database schema");
	} finally {
		expected.close();
	}
	if (version.user_version < 2) {
		validateLegacy();
		migrateWorldV1(db);
	}
	if (version.user_version < 3) {
		validateV2();
		migrateWorldV2(db);
	}
	if (version.user_version < 4) {
		validateV3();
		migrateWorldV3(db);
	}
}
