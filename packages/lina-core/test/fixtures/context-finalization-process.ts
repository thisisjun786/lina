import { join } from "node:path";
import { ContextStore } from "../../src/context/store.ts";
import { validateBinding } from "../../src/session-binding.ts";
import { DurableStore } from "../../src/store.ts";
import {
	appendContextEntry,
	extendContextEntry,
} from "../context-journal-fixture.ts";
import { entry } from "../fixture.ts";

const [root, bindingJson, mode] = process.argv.slice(2);
if (!root || !bindingJson || !["before", "after"].includes(mode ?? ""))
	throw Error("Invalid crash fixture arguments");
const binding = validateBinding(JSON.parse(bindingJson));
const journal = new DurableStore(join(root, "journal.sqlite"), binding);
const store = new ContextStore(
	join(root, "context.sqlite"),
	binding,
	(id) => journal.sourceEntry(id),
	{
		lookupRequest: (id) =>
			journal.sourceEntry(journal.request(id)?.entryId ?? ""),
	},
);
const requestId = appendContextEntry(
	journal,
	binding.sessionId,
	entry("user", { role: "user", text: "ordinary" }),
	false,
);
store.appendNote("stable-call", "survives process death", {
	activeRequestId: requestId,
});
extendContextEntry(journal, requestId);
journal.setRequest(requestId, "settled");
if (mode === "after") store.finalizeRequest(requestId);
process.kill(process.pid, "SIGKILL");
