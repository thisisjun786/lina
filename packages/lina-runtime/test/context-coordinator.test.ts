import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { ContextCoordinator } from "../src/context/coordinator.ts";
import type { CompactSourceEvent } from "../src/context/native.ts";
import type { ContextServices } from "../src/context/port.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});
function setup() {
	const f = createRuntimeFixture();
	for (const id of ["old", "kept"])
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: id,
			role: "user",
			text: `${id} decision and unfinished work. `.repeat(30),
			timestamp: "2026-09-05T00:00:00Z",
			raw: {},
		});
	const store = new ContextStore(
		join(f.root, "context.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
		{
			lookupRequest: (id) =>
				f.store.sourceEntry(f.store.request(id)?.entryId ?? ""),
		},
	);
	const services: ContextServices = {
		estimateText: (text) => Math.ceil(text.length / 4),
		estimateMessages: () => 100,
		systemTokens: 10,
		contextWindow: 100000,
		reserveTokens: 16384,
		summarize: async () => "Decision preserved; work remains unfinished.",
		prepare: (event) => ({
			requestId: event.requestId,
			firstKeptEntryId: "kept",
			tokensBefore: 1000,
			sourceEntryIds: ["old"],
			previousCompactionId: null,
			previousSummary: null,
			fits: () => true,
		}),
	};
	let manual = async (): Promise<unknown> => {
		throw new Error("Nothing to compact");
	};
	const coordinator = new ContextCoordinator({
		store,
		busy: () => false,
		compact: () => manual(),
	});
	coordinator.configure(services);
	cleanups.push(async () => {
		coordinator.close();
		store.close();
		await f.close();
	});
	return {
		...f,
		contextStore: store,
		coordinator,
		services,
		manual: (fn: typeof manual) => {
			manual = fn;
		},
	};
}
const event = (requestId = "compact-1"): CompactSourceEvent => ({
	requestId,
	reason: "manual",
	branchEntries: [],
	preparation: {
		firstKeptEntryId: "kept",
		tokensBefore: 1000,
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
	},
});

test("staged summary is inactive until a matching native receipt; restart can recover after native commit", async () => {
	const f = setup();
	const result = await f.coordinator.before(
		event(),
		new AbortController().signal,
	);
	expect(f.contextStore.active()).toBeNull();
	const receipt = { id: "native-compaction", type: "compaction", ...result };
	f.coordinator.restore([receipt]);
	expect(f.contextStore.active()?.nativeEntryId).toBe("native-compaction");
	expect(
		f.contextStore.expand({
			kind: "summary",
			id: f.contextStore.active()?.id ?? "",
		}).sources,
	).toContainEqual({ kind: "entry", id: "old" });
});
test("rejected or mismatched receipt cannot replace active summary", async () => {
	const f = setup();
	const result = await f.coordinator.before(
		event(),
		new AbortController().signal,
	);
	f.coordinator.rejected("compact-1");
	expect(f.contextStore.active()).toBeNull();
	expect(() =>
		f.coordinator.accepted("compact-1", {
			id: "bad",
			type: "compaction",
			...result,
			summary: "forged",
		}),
	).toThrow();
	expect(f.contextStore.active()).toBeNull();
});
test("manual compaction owns its fence and releases it after pre-hook native failure", async () => {
	const f = setup(),
		pending = Promise.withResolvers<unknown>();
	f.manual(() => pending.promise);
	const run = f.coordinator.manual();
	expect(f.coordinator.isBusy).toBe(true);
	await expect(f.coordinator.manual()).rejects.toThrow("busy");
	pending.reject(new Error("Nothing to compact"));
	await expect(run).rejects.toThrow("Nothing to compact");
	expect(f.coordinator.isBusy).toBe(false);
	expect(f.coordinator.state().status).toBe("failed");
});
test("working-state injection drops optional recall before bounded capsule and preserves input", () => {
	const f = setup();
	f.contextStore.updateWorking(
		0,
		{
			goal: "User's current goal",
			openItems: ["Finish the migration"],
			sourceEntryIds: ["old"],
		},
		{ activeRequestId: "context-old" },
	);
	f.coordinator.setRecall("Remembered preference. ".repeat(400));
	const messages = [{ role: "user", content: "Latest instruction" }];
	const text = f.coordinator.injection(messages);
	expect(text).toContain("User's current goal");
	expect(text.length).toBeLessThanOrEqual(8192);
	expect(messages).toEqual([{ role: "user", content: "Latest instruction" }]);
	f.coordinator.configure({ ...f.services, contextWindow: 16400 });
	expect(f.coordinator.injection(messages)).toBe("");
});

test("a candidate followed by native abort or settlement releases only its own fence", async () => {
	const f = setup(),
		signal = new AbortController();
	await f.coordinator.before(event(), signal.signal);
	expect(f.coordinator.isBusy).toBe(true);
	signal.abort();
	expect(f.coordinator.isBusy).toBe(false);
	const second = new AbortController();
	await f.coordinator.before(event("second"), second.signal);
	f.coordinator.settled();
	expect(f.coordinator.isBusy).toBe(false);
	await f.coordinator.before(event("third"), new AbortController().signal);
	second.abort();
	expect(f.coordinator.isBusy).toBe(true);
	f.coordinator.settled();
});

test("a lost summary database degrades then rebuilds from native originals", async () => {
	const f = setup();
	const candidate = await f.coordinator.before(
		event(),
		new AbortController().signal,
	);
	const receipt = { id: "c1", type: "compaction", ...candidate };
	appendContextEntry(f.store, f.runtime.binding.sessionId, {
		entryId: "c1",
		role: "meta",
		text: "",
		timestamp: "2026-09-05T00:00:00Z",
		raw: receipt,
	});
	appendContextEntry(f.store, f.runtime.binding.sessionId, {
		entryId: "tail",
		role: "user",
		text: "Recent work",
		timestamp: "2026-09-05T00:00:00Z",
		raw: {},
	});
	const fresh = new ContextStore(
		join(f.root, "fresh-context.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
		{
			lookupRequest: (id) =>
				f.store.sourceEntry(f.store.request(id)?.entryId ?? ""),
		},
	);
	const rebuilt = new ContextCoordinator({
		store: fresh,
		busy: () => false,
		compact: async () => {},
	});
	rebuilt.configure({
		...f.services,
		prepare: (e) => ({
			...f.services.prepare(e),
			firstKeptEntryId: "tail",
			sourceEntryIds: ["kept"],
			previousCompactionId: "c1",
			previousSummary: receipt.summary,
		}),
	});
	try {
		expect(() => rebuilt.restore([receipt])).not.toThrow();
		expect(rebuilt.state().status).toBe("failed");
		expect(rebuilt.state().recoveryNeeded).toBe(true);
		const result = await rebuilt.before(
			{
				...event("rebuild"),
				branchEntries: [{ id: "old" }, { id: "kept" }, receipt, { id: "tail" }],
			},
			new AbortController().signal,
		);
		rebuilt.accepted("rebuild", { id: "c2", type: "compaction", ...result });
		expect(fresh.active()?.nativeEntryId).toBe("c2");
		expect(fresh.get(fresh.active()?.id ?? "")?.sources).toContainEqual({
			kind: "entry",
			id: "old",
		});
	} finally {
		rebuilt.close();
		fresh.close();
	}
});

test("a later untracked native summary can replace the prior checkpoint after rebuilding", async () => {
	const f = setup();
	const candidate = await f.coordinator.before(
		event(),
		new AbortController().signal,
	);
	const first = { id: "c1", type: "compaction", ...candidate };
	f.coordinator.accepted("compact-1", first);
	const prior = f.contextStore.active()?.id;
	const foreign = {
		id: "c2",
		type: "compaction",
		summary: "Native summary outside the local checkpoint",
		firstKeptEntryId: "kept",
	};
	for (const raw of [first, foreign])
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: raw.id,
			role: "meta",
			text: "",
			timestamp: "2026-09-05T00:00:00Z",
			raw,
		});
	appendContextEntry(f.store, f.runtime.binding.sessionId, {
		entryId: "tail",
		role: "user",
		text: "Recent work",
		timestamp: "2026-09-05T00:00:00Z",
		raw: {},
	});
	expect(() => f.coordinator.restore([first, foreign])).not.toThrow();
	expect(f.contextStore.active()?.id).toBe(prior);
	f.coordinator.configure({
		...f.services,
		prepare: (e) => ({
			...f.services.prepare(e),
			firstKeptEntryId: "tail",
			sourceEntryIds: ["kept"],
			previousCompactionId: "c2",
			previousSummary: foreign.summary,
		}),
	});
	const result = await f.coordinator.before(
		{
			...event("repair"),
			branchEntries: [
				{ id: "old" },
				{ id: "kept" },
				first,
				foreign,
				{ id: "tail" },
			],
		},
		new AbortController().signal,
	);
	f.coordinator.accepted("repair", { id: "c3", type: "compaction", ...result });
	expect(f.contextStore.active()?.nativeEntryId).toBe("c3");
});
