import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireSessionLease } from "../../lina-core/src/session-binding.ts";
import { CompanionQueue } from "../src/context/companion-queue.ts";

// Requires a stopped app, its exclusive lease, and an explicit reviewed job allowlist.
const [stateRoot, workspace, botId, idsFile, reason] = process.argv.slice(2);
if (!stateRoot || !workspace || !botId || !idsFile || !reason)
	throw Error(
		"Usage: recover-memory.ts <state-root> <workspace> <bot-id> <ids.json> <unique-repair-reason>",
	);
const ids: unknown = JSON.parse(readFileSync(idsFile, "utf8"));
if (
	!Array.isArray(ids) ||
	ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)
)
	throw Error("Expected explicit job ID array");
const lease = acquireSessionLease(
	resolve(stateRoot),
	botId,
	resolve(workspace),
);
let queue: CompanionQueue | undefined;
try {
	const binding = lease.readBinding();
	if (!binding)
		throw Error("Missing existing binding; recovery never creates a session");
	queue = new CompanionQueue(join(lease.root, "mind.sqlite.queue"), binding);
	const recovered = queue.recover(ids, reason);
	console.log(
		JSON.stringify({
			recovered,
			requested: ids.length,
			reason,
			processing: queue.processing(),
			counts: queue.counts(),
		}),
	);
} finally {
	queue?.close();
	lease.close();
}
