import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	appendContextEntry,
	extendContextEntry,
} from "../../lina-core/test/context-journal-fixture.ts";
import { entry, Fixture } from "../../lina-core/test/fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { installMemoryQuery } from "../src/context/memory-query.ts";
import type { LinaHost, LinaTool } from "../src/host.ts";
import { fakeHost } from "./fake-host.ts";

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});

function setup(reason: Parameters<typeof installMemoryQuery>[3]) {
	const f = new Fixture();
	fixtures.push(f);
	const journal = f.store();
	const requestId = appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("evidence", { role: "user", text: "topic SYNTHETIC_SECRET" }),
	);
	const mind = f.keep(
		new EngineStore(join(f.dir, "mind.sqlite"), f.binding, {
			lookup: (id) => journal.sourceEntry(id),
		}),
	);
	const tools = new Map<string, LinaTool>();
	const host: LinaHost = {
		...fakeHost().api,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	};
	installMemoryQuery(host, mind, journal, reason);
	const tool = tools.get("lina_memory_query");
	if (!tool) throw Error("Memory query tool was not registered");
	return { journal, requestId, tool };
}

test("installed memory query rejects a microtask downgrade between reasoning and tool serialization", async () => {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<string>();
	let calls = 0;
	const f = setup((input) => {
		if (++calls === 1) return Promise.resolve('{"queries":["topic"]}');
		expect(input).toContain("SYNTHETIC_SECRET");
		entered.resolve();
		return gate.promise;
	});
	const pending = Promise.resolve(
		f.tool.execute("call", { query: "topic?" }, new AbortController().signal),
	);
	await entered.promise;
	gate.resolve("SYNTHETIC_SECRET [evidence]");
	queueMicrotask(() => extendContextEntry(f.journal, f.requestId, true));
	await expect(pending).rejects.toThrow(/provenance/);
	expect(f.journal.sourceEntry("evidence")?.sourcePolicy?.scope).toBe("mixed");
});

for (const mixed of [false, true]) {
	test(`memory tool delivery guard retains original proof after ${mixed ? "mixed downgrade" : "ordinary revision advance"}`, async () => {
		let calls = 0;
		const f = setup(() =>
			Promise.resolve(
				++calls === 1 ? '{"queries":["topic"]}' : "SYNTHETIC_SECRET [evidence]",
			),
		);
		const result = await f.tool.execute(
			"call",
			{ query: "topic?" },
			new AbortController().signal,
		);
		expect(result.details).toEqual({
			answer: "SYNTHETIC_SECRET [evidence]",
			sources: ["evidence"],
		});
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(result.details) },
		]);
		expect(Object.keys(result.details as object).sort()).toEqual([
			"answer",
			"sources",
		]);
		if (
			!("beforeDeliver" in result) ||
			typeof result.beforeDeliver !== "function"
		)
			throw Error("Memory result is missing its delivery guard");
		const guard = result.beforeDeliver;
		expect(() => guard()).not.toThrow();
		expect(() => guard()).not.toThrow();
		extendContextEntry(f.journal, f.requestId, mixed);
		expect(() => guard()).toThrow(/provenance/);
		expect(() => guard()).toThrow(/provenance/);
		expect(JSON.stringify(result)).not.toMatch(
			/beforeDeliver|sourceProofs|policyDigest/,
		);
	});
}

test("query retains the original source guard through an awaited provider owner before sending", async () => {
	const entered = Promise.withResolvers<void>(),
		gate = Promise.withResolvers<void>();
	let calls = 0,
		sent = 0;
	const f = setup(async (input, _signal, beforeDispatch?: () => void) => {
		if (++calls === 1) return '{"queries":["topic"]}';
		expect(input).toContain("SYNTHETIC_SECRET");
		entered.resolve();
		await gate.promise;
		beforeDispatch?.();
		sent++;
		return "SYNTHETIC_SECRET";
	});
	const pending = Promise.resolve(
		f.tool.execute("call", { query: "topic" }, new AbortController().signal),
	);
	await entered.promise;
	extendContextEntry(f.journal, f.requestId, true);
	gate.resolve();
	await expect(pending).rejects.toThrow(/source|provenance/i);
	expect(sent).toBe(0);
});
