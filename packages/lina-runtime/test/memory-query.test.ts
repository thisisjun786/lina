import { expect, test } from "bun:test";
import { join } from "node:path";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { queryMemory } from "../src/context/memory-query.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
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

test("policy-limited query can request more than one extra search round", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "rounds.sqlite"),
		f.runtime.binding,
		{
			lookup: (id) => f.store.sourceEntry(id),
		},
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "alpha",
			role: "user",
			text: "Project ALPHA lives in the first archive.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "beta",
			role: "user",
			text: "Project BETA lives in the later archive.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "now",
			role: "user",
			text: "Today we discussed tea.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		mind.apply({
			sourceProofs: captureSourceProofs(["now"], (id) =>
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
					sources: [{ entryId: "now", quote: "tea" }],
				},
			],
		});
		let calls = 0;
		const policy = {
			...defaultEnginePolicy(),
			memory: { ...defaultEnginePolicy().memory, maxSearchRounds: 2 },
		};
		const result = await queryMemory(
			"old project names?",
			mind,
			f.store,
			async (input) => {
				calls++;
				if (calls === 1) return JSON.stringify({ queries: ["ALPHA"] });
				if (calls === 2) {
					expect(input).toContain("ALPHA");
					return JSON.stringify({ queries: ["BETA"] });
				}
				expect(input).toContain("BETA");
				return "ALPHA and BETA";
			},
			new AbortController().signal,
			() => policy,
		);
		expect(calls).toBe(3);
		expect(result.sources).toEqual(expect.arrayContaining(["alpha", "beta"]));
		expect(result.coverage).toMatchObject({
			searchRounds: 2,
			incomplete: false,
		});
		expect(result.answer).toBe("ALPHA and BETA");
	} finally {
		mind.close();
		await f.close();
	}
});

test("policy change during a query round is rejected by the provenance guard", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "policy.sqlite"),
		f.runtime.binding,
		{
			lookup: (id) => f.store.sourceEntry(id),
		},
	);
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
		let revision = 0;
		await expect(
			queryMemory(
				"drink?",
				mind,
				f.store,
				async (_input, _signal, beforeDispatch) => {
					revision = 1;
					beforeDispatch?.();
					return "should not deliver";
				},
				new AbortController().signal,
				() => ({
					...defaultEnginePolicy(),
					revision,
					memory: { ...defaultEnginePolicy().memory },
				}),
			),
		).rejects.toThrow(/provenance|policy/i);
	} finally {
		mind.close();
		await f.close();
	}
});

test("exhausted search budget still makes a final answer call and does not search", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "budget.sqlite"),
		f.runtime.binding,
		{
			lookup: (id) => f.store.sourceEntry(id),
		},
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
		const policy = {
			...defaultEnginePolicy(),
			memory: { ...defaultEnginePolicy().memory, maxSearchRounds: 0 },
		};
		const result = await queryMemory(
			"What was the old codename?",
			mind,
			f.store,
			async (input) => {
				calls++;
				expect(input).toContain("No further searches");
				return JSON.stringify({ queries: ["codename"] });
			},
			new AbortController().signal,
			() => policy,
		);
		expect(calls).toBe(1);
		expect(result.sources).not.toContain("old");
		expect(result.coverage.incomplete).toBe(true);
		expect(result.coverage.reason).toBeTruthy();
		expect(result.answer).not.toContain("queries");
		expect(() => JSON.parse(result.answer)).toThrow();
	} finally {
		mind.close();
		await f.close();
	}
});

test("unknown keys on a search plan are rejected", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(
		join(f.root, "invalid.sqlite"),
		f.runtime.binding,
		{
			lookup: (id) => f.store.sourceEntry(id),
		},
	);
	try {
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
		await expect(
			queryMemory(
				"old name?",
				mind,
				f.store,
				async () => JSON.stringify({ queries: ["codename"], extra: true }),
				new AbortController().signal,
			),
		).rejects.toThrow(/Invalid memory search request/);
	} finally {
		mind.close();
		await f.close();
	}
});

test("query delivery fails after a selected record expires without a write", async () => {
	const f = createRuntimeFixture();
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	const mind = new EngineStore(
		join(f.root, "expiry.sqlite"),
		f.runtime.binding,
		{
			lookup: (id) => f.store.sourceEntry(id),
			now: () => now,
		},
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "u",
			role: "user",
			text: "I feel tired.",
			timestamp: "2026-01-01T00:00:00.000Z",
			raw: {},
		});
		const added = mind.apply({
			sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
			requestId: "r",
			expectedRevision: 0,
			observations: [
				{
					subject: "user",
					kind: "mood",
					key: "energy",
					text: "tired",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "tired" }],
				},
			],
		});
		const revision = added.revision;
		await expect(
			queryMemory(
				"mood?",
				mind,
				f.store,
				async (_input, _signal, beforeDispatch) => {
					now += 7 * 60 * 60 * 1000;
					beforeDispatch?.();
					return "expired";
				},
				new AbortController().signal,
			),
		).rejects.toThrow(/provenance/);
		expect(mind.snapshot().revision).toBe(revision);
	} finally {
		mind.close();
		await f.close();
	}
});

test("a long question cannot exceed the total policy input cap", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(join(f.root, "cap.sqlite"), f.runtime.binding, {
		lookup: (id) => f.store.sourceEntry(id),
	});
	const policy = defaultEnginePolicy();
	let calls = 0;
	try {
		await expect(
			queryMemory(
				"q".repeat(1500),
				mind,
				f.store,
				async () => {
					calls++;
					return "answer";
				},
				new AbortController().signal,
				() => ({ ...policy, memory: { ...policy.memory, inputChars: 1024 } }),
			),
		).rejects.toThrow(/budget/);
		expect(calls).toBe(0);
	} finally {
		mind.close();
		await f.close();
	}
});

test("record metadata and originals share the serialized input budget and disclose omissions", async () => {
	const f = createRuntimeFixture();
	const mind = new EngineStore(join(f.root, "tiny.sqlite"), f.runtime.binding, {
		lookup: (id) => f.store.sourceEntry(id),
	});
	const policy = defaultEnginePolicy();
	const seen: string[] = [];
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "u",
			role: "user",
			text: "tea ".repeat(500),
			timestamp: new Date().toISOString(),
			raw: {},
		});
		mind.apply({
			requestId: "r",
			expectedRevision: 0,
			sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
			observations: Array.from({ length: 20 }, (_, i) => ({
				subject: "user" as const,
				kind: "interest" as const,
				key: `tea.${i}`,
				text: "tea ".repeat(100),
				evidence: "explicit" as const,
				sources: [{ entryId: "u", quote: "tea" }],
			})),
		});
		const result = await queryMemory(
			"tea",
			mind,
			f.store,
			async (input) => {
				seen.push(input);
				return "Only partial evidence is available.";
			},
			new AbortController().signal,
			() => ({ ...policy, memory: { ...policy.memory, inputChars: 1024 } }),
		);
		expect(seen).toHaveLength(1);
		expect(seen.every((input) => input.length <= 1024)).toBe(true);
		expect(result.coverage.incomplete).toBe(true);
	} finally {
		mind.close();
		await f.close();
	}
});
