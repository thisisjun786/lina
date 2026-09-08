import { expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/store.ts";
import {
	appendContextEntry,
	extendContextEntry,
} from "../../lina-core/test/context-journal-fixture.ts";
import { entry, Fixture } from "../../lina-core/test/fixture.ts";
import { createSummaryTree } from "../src/context/tree.ts";

test("summary source guard reaches an awaited provider owner before the source text is sent", async () => {
	const f = new Fixture();
	const journal = f.store();
	const requestId = appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("evidence", {
			role: "user",
			text: "SYNTHETIC_SUMMARY_SECRET. ".repeat(40),
		}),
	);
	const store = f.keep(
		new ContextStore(join(f.dir, "context.sqlite"), f.binding, (id) =>
			journal.sourceEntry(id),
		),
	);
	const entered = Promise.withResolvers<void>(),
		gate = Promise.withResolvers<void>();
	let sent = 0;
	try {
		const pending = createSummaryTree(
			[{ kind: "entry", id: "evidence" }],
			store,
			async (_text, _max, _signal, beforeDispatch?: () => void) => {
				entered.resolve();
				await gate.promise;
				beforeDispatch?.();
				sent++;
				return "Summary";
			},
			new AbortController().signal,
			() => true,
		);
		await entered.promise;
		extendContextEntry(journal, requestId, true);
		gate.resolve();
		await expect(pending).rejects.toThrow(/source|provenance/i);
		expect(sent).toBe(0);
	} finally {
		f.close();
	}
});
