import { expect, test } from "bun:test";
import { join } from "node:path";
import { CompanionMemory } from "../src/context/companion.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("observed memory is reconsidered through both stages, persisted and not repeated on reopen", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const options = {
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	};
	let memory = new CompanionMemory(options),
		calls = 0;
	const observe = async () =>
		JSON.stringify([
			{
				subject: "user",
				kind: "interest",
				key: "walking",
				text: "Likes walking",
				evidence: "explicit",
				sources: [{ entryId: "u", quote: "walking" }],
			},
		]);
	const consolidate = async (text: string) => {
		calls++;
		const input = JSON.parse(text);
		if (input.stage === "deduction") return JSON.stringify({ proposals: [] });
		const record = input.records.find(
			(r: { key: string }) => r.key === "walking",
		);
		return JSON.stringify({
			proposals: [
				{
					subject: "user",
					kind: "interest",
					key: "parks",
					text: "May enjoy parks",
					reasoningKind: "induction",
					premises: [{ recordId: record.id, revision: record.revision }],
				},
			],
		});
	};
	const config = {
		consolidate,
		policy: defaultEnginePolicy,
		modelSettingsRevision: () => 0,
	};
	memory.configure(observe, undefined, config);
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "walking",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(calls).toBe(2);
		expect(
			memory.mind.state().records.find((r) => r.key === "parks")?.support,
		).toBe("provisional");
		expect(memory.status().consolidation?.state).toBe("committed");
		expect(await memory.recall("parks")).toContain("May enjoy parks");
		await memory.close();
		memory = new CompanionMemory(options);
		memory.configure(observe, undefined, config);
		await memory.refresh();
		expect(calls).toBe(2);
		expect(memory.mind.state().records.some((r) => r.key === "parks")).toBe(
			true,
		);
	} finally {
		await memory.close();
		await f.close();
	}
});

for (const change of ["close", "policy"] as const)
	test(`late consolidation output cannot commit after ${change}`, async () => {
		const f = createRuntimeFixture();
		trustNativeFixture(f.store, f.runtime.binding);
		const memory = new CompanionMemory({
			path: join(f.root, "mind.sqlite"),
			binding: f.runtime.binding,
			journal: f.store,
			schedule: () => () => {},
		});
		const entered = Promise.withResolvers<void>(),
			reply = Promise.withResolvers<string>();
		let policy = defaultEnginePolicy();
		memory.configure(
			async () =>
				JSON.stringify([
					{
						subject: "user",
						kind: "interest",
						key: "walking",
						text: "Likes walking",
						evidence: "explicit",
						sources: [{ entryId: "u", quote: "walking" }],
					},
				]),
			undefined,
			{
				policy: () => policy,
				modelSettingsRevision: () => 0,
				consolidate: async () => {
					entered.resolve();
					return reply.promise;
				},
			},
		);
		try {
			f.store.createRequest("r", "walking");
			f.store.appendEntry({
				entryId: "u",
				role: "user",
				text: "walking",
				timestamp: new Date().toISOString(),
				raw: {},
			});
			f.store.setRequest("r", "accepted", { entryId: "u" });
			f.store.setRequest("r", "settled");
			const running = memory.refresh();
			await entered.promise;
			if (change === "close") await memory.close();
			else policy = { ...policy, revision: 1 };
			reply.resolve('{"proposals":[]}');
			await running;
			if (change === "policy") {
				expect(memory.mind.currentRevision()).toBe(1);
				expect(
					memory.mind.reasoningJobs().some((job) => job.state === "committed"),
				).toBe(false);
			}
		} finally {
			reply.resolve('{"proposals":[]}');
			await memory.close();
			await f.close();
		}
	});

test("consolidation can inspect bounded original evidence rather than only observation excerpts", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	const seen: string[] = [];
	memory.configure(
		async () =>
			JSON.stringify([
				{
					subject: "user",
					kind: "interest",
					key: "walking",
					text: "Likes walking",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "walking" }],
				},
			]),
		undefined,
		{
			modelSettingsRevision: () => 0,
			consolidate: async (text) => {
				seen.push(text);
				return '{"proposals":[]}';
			},
		},
	);
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "I like walking only when the weather is cool.",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(seen).toHaveLength(2);
		expect(
			seen.every((text) => text.includes("only when the weather is cool")),
		).toBe(true);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("expired memory is withheld from cached context without a database write", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	let now = 1800000000000;
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: () => () => {},
	});
	memory.configure(async () =>
		JSON.stringify([
			{
				subject: "user",
				kind: "mood",
				key: "mood",
				text: "Feeling hopeful",
				evidence: "explicit",
				sources: [{ entryId: "u", quote: "hopeful" }],
			},
		]),
	);
	try {
		f.store.createRequest("r", "hopeful");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "hopeful",
			timestamp: new Date(now).toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		const text = await memory.recall("hopeful");
		expect(text).toContain("Feeling hopeful");
		const revision = memory.mind.currentRevision();
		now += 7 * 60 * 60 * 1000;
		expect(memory.mind.currentRevision()).toBe(revision);
		expect(memory.recallSourceProofs(text)).toBeUndefined();
	} finally {
		await memory.close();
		await f.close();
	}
});

test("missing consolidation route does not stop observation retry scheduling", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const wakes: number[] = [];
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: (_callback, delay) => {
			wakes.push(delay);
			return () => {};
		},
	});
	memory.configure(
		async () => {
			throw Error("temporary observation failure");
		},
		undefined,
		{
			consolidate: async () => '{"proposals":[]}',
			modelSettingsRevision: () => {
				throw Error("not_configured");
			},
		},
	);
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "walking",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(memory.detail().processing.error).not.toBe(
			"Companion scan or queue failed; progress preserved",
		);
		expect(wakes.some((delay) => delay > 0 && delay < 60000)).toBe(true);
		expect(memory.status().consolidation?.state).toBe("unavailable");
	} finally {
		await memory.close();
		await f.close();
	}
});

test("search exhaustion is withheld without automatic paid retry", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	let now = 1800000000000,
		calls = 0;
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: () => () => {},
	});
	const defaults = defaultEnginePolicy();
	memory.configure(
		async () =>
			JSON.stringify([
				{
					subject: "user",
					kind: "interest",
					key: "walking",
					text: "Likes walking",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "walking" }],
				},
			]),
		undefined,
		{
			policy: () => ({
				...defaults,
				memory: { ...defaults.memory, maxSearchRounds: 0 },
			}),
			modelSettingsRevision: () => 0,
			consolidate: async () => {
				calls++;
				return '{"queries":["walking"]}';
			},
		},
	);
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "walking",
			timestamp: new Date(now).toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		now += 30000;
		await memory.refresh();
		expect(calls).toBe(1);
		expect(memory.mind.reasoningJobs()[0]).toMatchObject({
			state: "withheld",
			error: "search_budget_exhausted",
		});
	} finally {
		await memory.close();
		await f.close();
	}
});

test("a record larger than the policy input budget is visibly withheld instead of pending forever", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	const policy = defaultEnginePolicy();
	let calls = 0;
	memory.configure(
		async () =>
			JSON.stringify([
				{
					subject: "user",
					kind: "interest",
					key: "walking",
					text: "walking ".repeat(150),
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "walking" }],
				},
			]),
		undefined,
		{
			modelSettingsRevision: () => 0,
			policy: () => ({
				...policy,
				memory: { ...policy.memory, inputChars: 1024 },
			}),
			consolidate: async () => {
				calls++;
				return '{"proposals":[]}';
			},
		},
	);
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "walking",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(calls).toBe(0);
		expect(memory.status().consolidation).toMatchObject({
			state: "withheld",
			incomplete: true,
			error: "input_budget_insufficient",
		});
	} finally {
		await memory.close();
		await f.close();
	}
});
