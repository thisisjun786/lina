import { expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { createContextTools } from "../src/context/tools.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("history/expansion tools bound results and working replacement respects the compaction fence", async () => {
	const f = createRuntimeFixture();
	const store = new ContextStore(
		join(f.root, "context.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
		{
			lookupRequest: (id) =>
				f.store.sourceEntry(f.store.request(id)?.entryId ?? ""),
		},
	);
	let busy = false;
	const tools = createContextTools(
		store,
		f.store,
		() => {},
		() => busy,
		() => "context-source",
		{
			policy: () => ({
				...defaultEnginePolicy(),
				context: { ...defaultEnginePolicy().context, expansionTokens: 8192 },
			}),
		},
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "source",
			role: "user",
			text: "User chose dark mode. ".repeat(500),
			timestamp: "2026-09-05T00:00:00Z",
			raw: {},
		});
		const search = await tools.search.execute("call", { query: "dark mode" });
		expect(search.content[0]?.text.length).toBeLessThan(1500);
		const page = await tools.expand.execute("call", {
			kind: "entry",
			id: "source",
		});
		expect(page.details.text.length).toBe(4096);
		expect(page.details.nextOffset).toBe(4096);
		await tools.update.execute("call", {
			expectedRevision: 0,
			goal: "Finish Lina",
			sourceEntryIds: ["source"],
		});
		expect(store.working().goal).toBe("Finish Lina");
		busy = true;
		await expect(
			tools.update.execute("call", { expectedRevision: 1, goal: "Overwrite" }),
		).rejects.toThrow("compaction");
		expect(store.working().goal).toBe("Finish Lina");
	} finally {
		store.close();
		await f.close();
	}
});
