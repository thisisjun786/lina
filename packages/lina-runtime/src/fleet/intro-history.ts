import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	checkedDirectory,
	checkedRegular,
} from "../../../lina-core/src/attachments/filesystem.ts";

/** Inspect ordinary history without starting Codex or creating/migrating a database. */
export function storedConversationEmpty(root: string): boolean {
	let db: DatabaseSync | undefined;
	try {
		checkedDirectory(root, false);
		const path = join(root, "state.sqlite");
		if (!lstatSync(path, { throwIfNoEntry: false }))
			return !lstatSync(join(root, "binding.json"), { throwIfNoEntry: false });
		checkedRegular(path);
		for (const suffix of ["-wal", "-shm", "-journal"])
			checkedRegular(path + suffix, false);
		db = new DatabaseSync(path, { readOnly: true });
		return (
			!db
				.prepare(
					"SELECT 1 FROM entries WHERE role IN ('user','assistant') LIMIT 1",
				)
				.get() &&
			!db
				.prepare(
					"SELECT 1 FROM requests WHERE status IN ('queued','accepted','settled','interrupted') LIMIT 1",
				)
				.get()
		);
	} catch {
		// Unknown existing state is never permission to restart someone's first experience.
		return false;
	} finally {
		db?.close();
	}
}
