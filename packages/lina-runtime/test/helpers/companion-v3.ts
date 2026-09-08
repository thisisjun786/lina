import { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";

// Exact queue schema at 3ff96e3, before source proofs.
const SQL =
	"\nCREATE TABLE companion_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor>=0), user_id TEXT, assistant_id TEXT) STRICT;\nCREATE TABLE companion_jobs (id TEXT PRIMARY KEY, sources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')), attempts INTEGER NOT NULL CHECK(attempts>=0), retry_at INTEGER NOT NULL CHECK(retry_at>=0), error TEXT) STRICT;\nCREATE INDEX companion_ready ON companion_jobs(state,retry_at);\nCREATE TABLE companion_job_meta (id TEXT PRIMARY KEY REFERENCES companion_jobs(id), allowance INTEGER NOT NULL, outcome TEXT, reset_revision INTEGER) STRICT;\nCREATE TABLE companion_history (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, event TEXT NOT NULL, attempt INTEGER NOT NULL, at INTEGER NOT NULL, error TEXT) STRICT;";
export function companionV3(path: string, binding: BotBinding) {
	const db = new DatabaseSync(path);
	db.exec(SQL);
	db.exec("PRAGMA user_version=3");
	db.prepare("INSERT INTO companion_meta VALUES(1,?,4,NULL,NULL)").run(
		JSON.stringify(binding),
	);
	for (const state of ["pending", "running", "failed", "done"]) {
		db.prepare("INSERT INTO companion_jobs VALUES(?,?,?,2,0,?)").run(
			state,
			JSON.stringify([state]),
			state,
			"old_error",
		);
		db.prepare("INSERT INTO companion_job_meta VALUES(?,3,NULL,NULL)").run(
			state,
		);
		db.prepare(
			"INSERT INTO companion_history(id,event,attempt,at,error) VALUES(?,'failed',2,0,'old_error')",
		).run(state);
	}
	db.close();
}
