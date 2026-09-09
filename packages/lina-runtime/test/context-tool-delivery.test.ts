import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/store.ts";
import {
	appendContextEntry,
	extendContextEntry,
} from "../../lina-core/test/context-journal-fixture.ts";
import { entry, Fixture } from "../../lina-core/test/fixture.ts";
import { createContextTools } from "../src/context/tools.ts";
import { createNotepadTools } from "../src/tools/notepad.ts";

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup(accepted = false) {
	const f = new Fixture();
	fixtures.push(f);
	const journal = f.store();
	const requestId = appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("source", { role: "user", text: "topic SYNTHETIC_SECRET" }),
		!accepted,
	);
	const context = f.keep(
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
	const tools = createContextTools(
		context,
		journal,
		() => {},
		() => false,
		() => requestId,
	);
	const notepad = createNotepadTools(context, () => requestId);
	return { context, journal, requestId, tools, notepad };
}
function deliveryGuard(result: object) {
	if (
		!("beforeDeliver" in result) ||
		typeof result.beforeDeliver !== "function"
	)
		throw Error("Source-aware result is missing beforeDeliver");
	return result.beforeDeliver;
}

for (const kind of [
	"history",
	"entry",
	"summary",
	"notepad",
	"working",
] as const) {
	test(`${kind} tool captures original delivery proof before async host continuations`, async () => {
		const f = setup();
		let result: object;
		if (kind === "history")
			result = await f.tools.search.execute("call", { query: "topic" });
		else if (kind === "entry")
			result = await f.tools.expand.execute("call", {
				kind: "entry",
				id: "source",
			});
		else if (kind === "summary") {
			const node = f.context.stage({
				text: "SYNTHETIC_SECRET",
				kind: "model",
				sources: [{ kind: "entry", id: "source" }],
			});
			result = await f.tools.expand.execute("call", {
				kind: "summary",
				id: node.id,
			});
		} else if (kind === "notepad") {
			await f.notepad.append.execute("append", { text: "SYNTHETIC_SECRET" });
			f.context.finalizeRequest(f.requestId);
			result = await f.notepad.read.execute();
		} else {
			result = await f.tools.update.execute("call", {
				expectedRevision: 0,
				goal: "SYNTHETIC_SECRET",
			});
		}
		expect(JSON.stringify(result)).toContain("SYNTHETIC_SECRET");
		const guard = deliveryGuard(result);
		expect(() => guard()).not.toThrow();
		// Ordinary revision changes also invalidate frozen settled proofs: no recapture.
		extendContextEntry(f.journal, f.requestId);
		expect(() => guard()).toThrow(/provenance|source/i);
		extendContextEntry(f.journal, f.requestId, true);
		expect(() => guard()).toThrow(/provenance|source/i);
		expect(JSON.stringify(result)).not.toMatch(
			/beforeDeliver|sourceProofs|policyDigest/,
		);
	});
}

test("pending working delivery binds creation identity and dependencies while allowing ordinary exposure progress", async () => {
	const f = setup(true);
	const result = await f.tools.update.execute("call", {
		expectedRevision: 0,
		goal: "SYNTHETIC_SECRET",
	});
	const guard = deliveryGuard(result);
	extendContextEntry(f.journal, f.requestId);
	expect(() => guard()).not.toThrow();
	extendContextEntry(f.journal, f.requestId, true);
	expect(() => guard()).toThrow(/provenance|source/i);
});

test("status callers can preserve the guarded working view without exposing proof metadata", () => {
	const f = setup();
	f.context.updateWorking(
		0,
		{ goal: "SYNTHETIC_SECRET" },
		{ activeRequestId: f.requestId },
	);
	f.context.finalizeRequest(f.requestId);
	const read = f.context.readWorking();
	expect(read.value.goal).toBe("SYNTHETIC_SECRET");
	expect(() => read.beforeDeliver()).not.toThrow();
	extendContextEntry(f.journal, f.requestId);
	expect(() => read.beforeDeliver()).toThrow(/provenance|source/i);
	expect(JSON.stringify(read.value)).not.toMatch(
		/beforeDeliver|sourceProofs|policyDigest/,
	);
});

test("pending working delivery keeps settled dependencies frozen", async () => {
	const f = setup(true);
	const citationRequest = appendContextEntry(
		f.journal,
		"session-1",
		entry("citation", { role: "user", text: "original citation" }),
	);
	const result = await f.tools.update.execute("call", {
		expectedRevision: 0,
		goal: "SYNTHETIC_SECRET",
		sourceEntryIds: ["citation"],
	});
	const guard = deliveryGuard(result);
	expect(() => guard()).not.toThrow();
	extendContextEntry(f.journal, citationRequest);
	extendContextEntry(f.journal, f.requestId);
	expect(() => guard()).toThrow(/provenance|source/i);
});

test("active summary status carries the original proof through its delivery guard", () => {
	const f = setup();
	const summary = f.context.stage({
		text: "SYNTHETIC_SECRET",
		kind: "model",
		sources: [{ kind: "entry", id: "source" }],
	});
	f.context.activate({
		id: summary.id,
		nativeEntryId: "native",
		firstKeptEntryId: "source",
		expectedActiveId: null,
	});
	const read = f.context.readActive();
	expect(read.value?.id).toBe(summary.id);
	expect(() => read.beforeDeliver()).not.toThrow();
	extendContextEntry(f.journal, f.requestId);
	expect(() => read.beforeDeliver()).toThrow(/provenance|source/i);
});

test("C3 pending callback switches to the saved final proof after durable settlement", async () => {
	const f = setup(true);
	const result = await f.tools.update.execute("call", {
		expectedRevision: 0,
		goal: "ORIGINAL_WORKING_TEXT",
	});
	const guard = deliveryGuard(result);
	extendContextEntry(f.journal, f.requestId);
	f.journal.setRequest(f.requestId, "settled");
	expect(f.context.finalizeRequest(f.requestId)).toBe(1);
	expect(() => guard()).not.toThrow();
	extendContextEntry(f.journal, f.requestId);
	expect(f.context.working().goal).toBe("");
	expect(() => guard()).toThrow(/provenance|source/i);
});
