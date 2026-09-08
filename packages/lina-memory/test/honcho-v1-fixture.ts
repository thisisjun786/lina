import { DatabaseSync } from "node:sqlite";
import { publicIdentity } from "../src/honcho/config.ts";
import { config, type Fixture } from "./honcho-fixture.ts";
export const namespace = {
	version: 1 as const,
	ownerBotId: "lina",
	generationId: "g1",
	workspaceId: "ordinary-lina",
	sessionId: "ordinary-session",
	userPeerId: "ordinary-user",
	observerPeerId: "ordinary-observer",
	sourcePolicyVersion: 1 as const,
	qualificationId: "local-fixture-q1",
};
// Exact pre-050 schema bytes, independent of the migration's implementation.
export function legacyOutbox(fixture: Fixture): void {
	const db = new DatabaseSync(fixture.file);
	db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE parts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, part_index INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','unknown','failed')),
 remote_id TEXT, error TEXT, UNIQUE(entry_id, part_index)
) STRICT;
CREATE INDEX open_parts ON parts(state, id) WHERE state IN ('pending','unknown');
CREATE TABLE scan (
 id INTEGER PRIMARY KEY CHECK(id = 1), after INTEGER NOT NULL,
 eligible_user INTEGER NOT NULL CHECK(eligible_user IN (0,1))
) STRICT;
PRAGMA user_version = 1;`);
	db.prepare("INSERT INTO meta VALUES ('owner', ?)").run(
		JSON.stringify({
			binding: fixture.binding,
			identity: publicIdentity(config),
		}),
	);
	db.exec("INSERT INTO scan VALUES (1, 42, 1)");
	for (const [i, state] of [
		"pending",
		"unknown",
		"sending",
		"accepted",
		"failed",
	].entries()) {
		db.prepare(
			"INSERT INTO parts(entry_id,part_index,role,content,content_hash,state,remote_id,error) VALUES (?,0,'user',?,?,?, ?,?)",
		).run(
			`old-${i}`,
			`old text ${i}`,
			"a".repeat(64),
			state,
			state === "accepted" ? "old-remote" : null,
			"old attempt detail",
		);
	}
	db.close();
}
