import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/store.ts";
import {
	appendContextEntry,
	extendContextEntry,
} from "../../lina-core/test/context-journal-fixture.ts";
import { ContextSourceFixture } from "../../lina-core/test/context-source-fixture.ts";
import { entry, Fixture } from "../../lina-core/test/fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { ContextCoordinator } from "../src/context/coordinator.ts";
import { ExternalContext } from "../src/context/external.ts";
import { queryMemory } from "../src/context/memory-query.ts";
import { activateReceipt } from "../src/context/receipts.ts";
import { createContextTools } from "../src/context/tools.ts";
import { createSummaryTree, nativeSummary } from "../src/context/tree.ts";
import { createNotepadTools } from "../src/tools/notepad.ts";

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = new Fixture();
	fixtures.push(f);
	const journal = f.store();
	const open = () =>
		f.keep(
			new ContextStore(
				join(f.dir, "context.sqlite"),
				f.binding,
				(id) => journal.sourceEntry(id),
				{
					lookupRequest: (id) =>
						journal.sourceEntry(journal.request(id)?.entryId ?? ""),
				},
			),
		);
	const add = (id: string, text: string, settle = true, mixed = false) =>
		appendContextEntry(
			journal,
			f.binding.sessionId,
			entry(id, { role: "user", text }),
			settle,
			mixed,
		);
	return { f, journal, open, add };
}

test("history and ExternalContext filter many masked sources before result limits and model input", async () => {
	const { journal, open, add } = setup();
	const store = open();
	add("valid", "topic permitted answer");
	for (let i = 0; i < 42; i++) add(`masked-${i}`, "topic SECRET", true, true);
	const tools = createContextTools(
		store,
		journal,
		() => {},
		() => false,
	);
	const search = await tools.search.execute("search", { query: "topic" });
	expect(search.details.messages.map((m) => m.entryId)).toEqual(["valid"]);
	expect(JSON.stringify(search)).not.toContain("SECRET");
	const inputs: string[] = [];
	const external = new ExternalContext(
		store,
		journal,
		async (text) => {
			inputs.push(text);
			return "permitted answer";
		},
		{ thresholdChars: 1 },
	);
	await external.refresh(new AbortController().signal);
	expect(inputs).toHaveLength(1);
	expect(inputs[0]).not.toContain("SECRET");
	expect(inputs[0]).toContain("topic permitted answer");
	expect(external.injection()).toContain("permitted answer");
	expect(journal.search("SECRET").messages).toHaveLength(20);
});

test("notepad actual tool stores pending, survives finalization/reopen and never reads legacy plaintext", async () => {
	const { f, journal, open, add } = setup();
	const requestId = add("user", "remember", false);
	writeFileSync(join(f.dir, "notepad.md"), "LEGACY_SECRET");
	let store = open();
	let tools = createNotepadTools(store, () => requestId);
	const first = await tools.append.execute("stable-call", {
		text: "ordinary note",
	});
	expect(first.content[0]?.text).not.toContain("ordinary note");
	expect((await tools.read.execute()).content[0]?.text).toBe("(empty)");
	extendContextEntry(journal, requestId);
	journal.setRequest(requestId, "settled");
	store.close();
	store = open();
	tools = createNotepadTools(store, () => requestId);
	expect((await tools.read.execute()).content[0]?.text).toContain(
		"ordinary note",
	);
	expect(
		(await tools.append.execute("stable-call", { text: "ordinary note" }))
			.details.id,
	).toBe(first.details.id);
	expect(store.notes()).toHaveLength(1);
	expect(readFileSync(join(f.dir, "notepad.md"), "utf8")).toBe("LEGACY_SECRET");
});

test("mixed append followed by clean scope and reopen never echoes secret or promotes note", async () => {
	const { journal, open, add } = setup();
	let requestId = add("mixed", "source", false);
	let store = open();
	const tools = createNotepadTools(store, () => requestId);
	await tools.append.execute("call", { text: "SECRET" });
	extendContextEntry(journal, requestId, true);
	journal.setRequest(requestId, "settled");
	store.finalizeRequest(requestId);
	requestId = add("clean", "clean source", false);
	store.close();
	store = open();
	const result = await createNotepadTools(
		store,
		() => requestId,
	).read.execute();
	expect(JSON.stringify(result)).not.toContain("SECRET");
	expect(store.notes()).toEqual([]);
});

test("summary rejects a policy changed during await, and a cache revision cannot launder old output", async () => {
	const f = new ContextSourceFixture();
	fixtures.push(f);
	f.add("user", "original source ".repeat(20));
	const store = f.keep(
		new ContextStore(join(f.dir, "context.sqlite"), f.binding, f.lookup),
	);
	const refs = [{ kind: "entry" as const, id: "user" }];
	const signal = new AbortController().signal;
	await expect(
		createSummaryTree(
			refs,
			store,
			async () => {
				f.extend("user");
				return "stale derived output";
			},
			signal,
			() => true,
		),
	).rejects.toThrow(/source|provenance/i);
	let calls = 0;
	const call = async () => {
		calls++;
		return "fresh summary";
	};
	const first = await createSummaryTree(
		refs,
		store,
		call,
		signal,
		() => true,
		"same-model",
	);
	f.extend("user");
	const second = await createSummaryTree(
		refs,
		store,
		call,
		signal,
		() => true,
		"same-model",
	);
	expect(calls).toBe(2);
	expect(first.id).not.toBe(second.id);
});

test("native summary receipts version independently and withhold legacy or wrong ancestry receipts", () => {
	const { open, add } = setup();
	add("source", "ordinary");
	const store = open();
	const node = store.stage({
		kind: "model",
		text: "summary",
		sources: [{ kind: "entry", id: "source" }],
	});
	const receipt = {
		type: "compaction",
		id: "native",
		summary: nativeSummary(node),
		firstKeptEntryId: "source",
		details: {
			linaContext: { version: 1, id: node.id, expectedActiveId: null },
		},
	};
	expect(() => activateReceipt(store, receipt)).toThrow();
	expect(store.active()).toBeNull();
	const scoped = {
		...receipt,
		details: {
			linaContext: {
				...receipt.details.linaContext,
				version: 2,
				sourceProofs: node.sourceProofs,
			},
		},
	};
	expect(activateReceipt(store, scoped)).toBe(true);
	expect(() =>
		activateReceipt(store, {
			...scoped,
			details: {
				linaContext: { ...scoped.details.linaContext, sourceProofs: [] },
			},
		}),
	).toThrow();
});

test("memory extra search reaches eligible evidence behind masked hits and rechecks after reasoning", async () => {
	const { f, journal, add } = setup();
	add("valid", "topic allowed");
	for (let i = 0; i < 30; i++) add(`masked-${i}`, "topic SECRET", true, true);
	const mind = f.keep(
		new EngineStore(join(f.dir, "mind.sqlite"), f.binding, {
			lookup: (id) => journal.sourceEntry(id),
		}),
	);
	let calls = 0;
	const result = await queryMemory(
		"topic?",
		mind,
		journal,
		async (input) => {
			if (++calls === 1) return '{"queries":["topic"]}';
			expect(input).not.toContain("SECRET");
			expect(input).toContain("topic allowed");
			return "allowed [valid]";
		},
		new AbortController().signal,
	);
	expect(result.sources).toEqual(["valid"]);
});

test("context injection checks pending working and cached recall at the last model boundary", () => {
	const { open, add, journal } = setup();
	const requestId = add("user", "safe", false);
	const store = open();
	store.updateWorking(0, { goal: "SECRET" }, { activeRequestId: requestId });
	const coordinator = new ContextCoordinator({
		store,
		busy: () => false,
		compact: async () => {},
		activeRequestId: () => requestId,
	});
	coordinator.configure({
		contextWindow: 10000,
		systemTokens: 0,
		reserveTokens: 1,
		estimateMessages: () => 0,
		estimateText: (t) => t.length,
		summarize: async () => "",
		prepare: () => {
			throw Error("unused");
		},
	});
	let recalled = "RECALLED_SECRET";
	coordinator.setRecall(recalled, () => recalled);
	const prepared = coordinator.readInjection([]);
	expect(prepared.content).toContain("RECALLED_SECRET");
	expect(() => prepared.beforeDeliver()).not.toThrow();
	extendContextEntry(journal, requestId, true);
	recalled = "";
	expect(() => prepared.beforeDeliver()).toThrow(/source|context|recall/i);
	expect(coordinator.injection([])).not.toContain("SECRET");
	coordinator.close();
});

test("unqualified native summary text cannot bypass archive admission through an ordinary wrapper entry", async () => {
	const { f, open, journal } = setup();
	appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("old-summary", {
			role: "assistant",
			text: "SECRET",
			raw: { message: { role: "compactionSummary", summary: "SECRET" } },
		}),
	);
	const store = open();
	const tools = createContextTools(
		store,
		journal,
		() => {},
		() => false,
	);
	expect(() => store.expand({ kind: "entry", id: "old-summary" })).toThrow();
	expect(
		(await tools.search.execute("call", { query: "SECRET" })).details.messages,
	).toEqual([]);
	expect(journal.entry("old-summary")?.text).toBe("SECRET");
});

test("memory query discards an answer when an extra search source changes during await", async () => {
	const { f, journal, add } = setup();
	const requestId = add("evidence", "topic ordinary");
	const mind = f.keep(
		new EngineStore(join(f.dir, "query.sqlite"), f.binding, {
			lookup: (id) => journal.sourceEntry(id),
		}),
	);
	let calls = 0;
	await expect(
		queryMemory(
			"topic?",
			mind,
			journal,
			async () => {
				if (++calls === 1) return '{"queries":["topic"]}';
				extendContextEntry(journal, requestId, true);
				return "stale answer";
			},
			new AbortController().signal,
		),
	).rejects.toThrow(/provenance/);
});
