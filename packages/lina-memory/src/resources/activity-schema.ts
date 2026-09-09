import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const SCHEMA = `
CREATE TABLE resource_activities (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,actor_agent_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE resource_activity_deliveries (activity_id TEXT NOT NULL,activity_revision INTEGER NOT NULL,world_id TEXT NOT NULL,grant_revision INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(activity_id,activity_revision,world_id,grant_revision)) STRICT;
CREATE TABLE resource_activity_operations (operation_id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,UNIQUE(activity_id,revision)) STRICT;
`;

function objects(db: DatabaseSync): unknown[] {
	return db
		.prepare(
			"SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		.all()
		.map((r) => ({
			...r,
			sql:
				typeof r["sql"] === "string"
					? r["sql"].replace(/\s+/g, " ").trim()
					: r["sql"],
		}));
}

const expected = (() => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(SCHEMA);
		return objects(db);
	} finally {
		db.close();
	}
})();

export function verifyActivitySchema(db: DatabaseSync): void {
	if (
		db.prepare("PRAGMA user_version").get()?.["user_version"] !== 1 ||
		!isDeepStrictEqual(objects(db), expected)
	)
		throw Error("corrupt resource activity schema");
}

export function initializeActivities(db: DatabaseSync, fresh: boolean): void {
	if (fresh) {
		db.exec(SCHEMA);
		db.exec("PRAGMA user_version=1");
	}
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	if (version !== 1) throw Error("corrupt resource activity schema version");
	verifyActivitySchema(db);
}
