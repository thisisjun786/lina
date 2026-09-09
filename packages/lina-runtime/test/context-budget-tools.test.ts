import { expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { createContextTools } from "../src/context/tools.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("context tools bound serialized pages and scope search counts to the active request", async () => {
	const f = createRuntimeFixture(),
		store = new ContextStore(
			join(f.root, "tool-budget.sqlite"),
			f.runtime.binding,
			(id) => f.store.sourceEntry(id),
		);
	const text = "원문😀 원문이유 ".repeat(200);
	appendContextEntry(f.store, f.runtime.binding.sessionId, {
		entryId: "source",
		role: "user",
		text,
		timestamp: "2026-09-08T00:00:00Z",
		raw: {},
	});
	let request = "one";
	const policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			maxSearchCalls: 1,
			expansionTokens: 500,
		},
	};
	const tools = createContextTools(
		store,
		f.store,
		() => {},
		() => false,
		() => request,
		{ policy: () => policy, estimator: () => conservativeEstimator },
	);
	try {
		const search = await tools.search.execute("one", { query: "원문" });
		expect(
			conservativeEstimator.text(JSON.stringify(search.details)),
		).toBeLessThanOrEqual(500);
		await expect(
			tools.search.execute("two", { query: "원문" }),
		).rejects.toThrow(/search.*budget/);
		request = "two";
		await tools.search.execute("three", { query: "원문" });
		let offset = 0,
			restored = "";
		for (;;) {
			const page = await tools.expand.execute("p", {
				kind: "entry",
				id: "source",
				offset,
			});
			expect(
				conservativeEstimator.text(JSON.stringify(page.details)),
			).toBeLessThanOrEqual(500);
			expect(page.details.text.isWellFormed()).toBe(true);
			restored += page.details.text;
			if (page.details.nextOffset === null) break;
			expect(page.details.nextOffset).toBeGreaterThan(offset);
			offset = page.details.nextOffset;
		}
		expect(restored).toContain(text);
	} finally {
		store.close();
		await f.close();
	}
});
