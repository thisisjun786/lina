import { join } from "node:path";
import { openCheckedDatabase } from "../session-binding.ts";

/** Held for the fleet or an offline checkpoint; SQLite releases it after crashes. */
export function acquireInstallationLock(stateRoot: string): { close(): void } {
	const { db } = openCheckedDatabase(
		join(stateRoot, "installation-lock.sqlite"),
	);
	try {
		if (db.prepare("PRAGMA journal_mode").get()?.["journal_mode"] !== "delete")
			throw Error("Unsupported installation lock journal mode");
		db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
	} catch {
		db.close();
		throw Error(
			"Lina state is busy; stop its runtime before checkpoint or restore",
		);
	}
	let closed = false;
	return {
		close() {
			if (closed) return;
			try {
				db.exec("ROLLBACK");
			} finally {
				db.close();
				closed = true;
			}
		},
	};
}
