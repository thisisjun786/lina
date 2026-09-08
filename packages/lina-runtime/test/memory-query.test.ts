import { expect, test } from "bun:test";
import { join } from "node:path";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { queryMemory } from "../src/context/memory-query.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("deep memory query retrieves original evidence without writing memory", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(join(f.root, "mind.sqlite"), f.runtime.binding, {
		lookup: (id) => f.store.sourceEntry(id),
	});
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "u",
			role: "user",
			text: "I prefer jasmine tea.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		mind.apply({
			sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
			requestId: "r",
			expectedRevision: 0,
			observations: [
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "Prefers jasmine tea",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "jasmine tea" }],
				},
			],
		});
		const before = mind.snapshot();
		const inputs: string[] = [];
		const result = await queryMemory(
			"drink?",
			mind,
			f.store,
			async (text) => {
				inputs.push(text);
				return "Jasmine tea [u]";
			},
			new AbortController().signal,
		);
		expect(inputs[0]).toContain("I prefer jasmine tea.");
		expect(inputs[0]).toContain('"evidence":"explicit"');
		expect(inputs[0]).toContain('"expiresAt":null');
		expect(result.answer).toContain("[u]");
		expect(result.sources).toContain("u");
		expect(mind.snapshot().revision).toBe(before.revision);
	} finally {
		mind.close();
		await f.close();
	}
});

test("deep query includes cited evidence near the end of a long original", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(join(f.root, "long.sqlite"), f.runtime.binding, {
		lookup: (id) => f.store.sourceEntry(id),
	});
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "long",
			role: "user",
			text: "background ".repeat(1000) + "I now prefer oolong.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		mind.apply({
			sourceProofs: captureSourceProofs(["long"], (id) =>
				f.store.sourceEntry(id),
			),
			requestId: "r",
			expectedRevision: 0,
			observations: [
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "oolong",
					evidence: "explicit",
					sources: [{ entryId: "long", quote: "I now prefer oolong." }],
				},
			],
		});
		let input = "";
		await queryMemory(
			"oolong",
			mind,
			f.store,
			async (text) => {
				input = text;
				return "oolong";
			},
			new AbortController().signal,
		);
		expect(input).toContain("I now prefer oolong.");
	} finally {
		mind.close();
		await f.close();
	}
});

test("memory reasoning can request a bounded source search beyond its recent context", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "search.sqlite"),
		f.runtime.binding,
		{ lookup: (id) => f.store.sourceEntry(id) },
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "old",
			role: "user",
			text: "The old project codename is ORCHID.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "new",
			role: "user",
			text: "Today we discussed tea.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		mind.apply({
			sourceProofs: captureSourceProofs(["new"], (id) =>
				f.store.sourceEntry(id),
			),
			requestId: "r",
			expectedRevision: 0,
			observations: [
				{
					subject: "user",
					kind: "fact",
					key: "today",
					text: "Discussed tea",
					evidence: "explicit",
					sources: [{ entryId: "new", quote: "tea" }],
				},
			],
		});
		let calls = 0;
		const result = await queryMemory(
			"What was the old codename?",
			mind,
			f.store,
			async (input) => {
				calls++;
				if (calls === 1) return JSON.stringify({ queries: ["codename"] });
				expect(input).toContain("ORCHID");
				return "ORCHID [old]";
			},
			new AbortController().signal,
		);
		expect(calls).toBe(2);
		expect(result.sources).toContain("old");
		expect(result.answer).toBe("ORCHID [old]");
	} finally {
		mind.close();
		await f.close();
	}
});

test("source search does not reintroduce evidence invalidated by memory retraction", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "retract.sqlite"),
		f.runtime.binding,
		{ lookup: (id) => f.store.sourceEntry(id) },
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "u",
			role: "user",
			text: "SECRET-PREFERENCE",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		const added = mind.apply({
			sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
			requestId: "r",
			expectedRevision: 0,
			observations: [
				{
					subject: "user",
					kind: "preference",
					key: "pref",
					text: "SECRET-PREFERENCE",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "SECRET-PREFERENCE" }],
				},
			],
		});
		const record = added.records[0];
		if (!record) throw Error("missing fixture record");
		mind.retract(record.id, added.revision);
		let calls = 0;
		await queryMemory(
			"old preference",
			mind,
			f.store,
			async (input) => {
				calls++;
				if (calls === 1)
					return JSON.stringify({ queries: ["SECRET-PREFERENCE"] });
				expect(input).not.toContain("SECRET-PREFERENCE");
				return "No applicable evidence";
			},
			new AbortController().signal,
		);
	} finally {
		mind.close();
		await f.close();
	}
});
