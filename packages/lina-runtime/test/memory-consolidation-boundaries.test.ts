import { expect, test } from "bun:test";
import { join } from "node:path";
import { CompanionMemory } from "../src/context/companion.ts";
import {
	defaultEnginePolicy,
	type EnginePolicySnapshot,
} from "../src/context/policy-settings.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

type ScheduleHandle = { fire: () => void; delay: number };

function policySnapshot(
	memory: Partial<EnginePolicySnapshot["memory"]> = {},
): EnginePolicySnapshot {
	const base = defaultEnginePolicy();
	return {
		...base,
		memory: { ...base.memory, ...memory },
	};
}

function explicitObservation(entryId: string, key: string, text: string) {
	return {
		subject: "user" as const,
		kind: "interest" as const,
		key,
		text,
		evidence: "explicit" as const,
		sources: [{ entryId, quote: text }],
	};
}

function settle(
	f: ReturnType<typeof createRuntimeFixture>,
	requestId: string,
	entryId: string,
	text: string,
) {
	f.store.createRequest(requestId, text);
	f.store.appendEntry({
		entryId,
		role: "user",
		text,
		timestamp: "2026-09-08T00:00:00.000Z",
		raw: {},
	});
	f.store.setRequest(requestId, "accepted", { entryId });
	f.store.setRequest(requestId, "settled");
}

function signalSchedule() {
	const pending: ScheduleHandle[] = [];
	let waiter: PromiseWithResolvers<void> | undefined;
	const notify = () => {
		if (pending.length && waiter) {
			const ready = waiter;
			waiter = undefined;
			ready.resolve();
		}
	};
	return {
		schedule: (callback: () => void, delay: number) => {
			const handle: ScheduleHandle = {
				delay,
				fire: () => {
					const index = pending.indexOf(handle);
					if (index >= 0) pending.splice(index, 1);
					callback();
				},
			};
			pending.push(handle);
			notify();
			return () => {
				const index = pending.indexOf(handle);
				if (index >= 0) pending.splice(index, 1);
			};
		},
		queued: () => pending.length,
		async next(): Promise<ScheduleHandle> {
			while (!pending.length) {
				waiter = Promise.withResolvers<void>();
				await waiter.promise;
			}
			const handle = pending[0];
			if (!handle) throw new Error("missing scheduled wake");
			return handle;
		},
	};
}

test("maxVisits 1 pages more than twenty stage jobs and drains remaining pages through scheduled wakes", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const wakes = signalSchedule();
	let cycle = Promise.withResolvers<void>();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: wakes.schedule,
		onChange: () => cycle.resolve(),
	});
	const keys = Array.from({ length: 12 }, (_, index) => `topic.${index}`);
	const seen: { stage: string; keys: string[] }[] = [];
	memory.configure(
		async () =>
			JSON.stringify(keys.map((key) => explicitObservation("u", key, key))),
		undefined,
		{
			policy: () => policySnapshot({ maxVisits: 1, maxSearchRounds: 0 }),
			modelSettingsRevision: () => 0,
			consolidate: async (text) => {
				const input = JSON.parse(text) as {
					stage: string;
					records: { key: string }[];
				};
				seen.push({
					stage: input.stage,
					keys: input.records.map((record) => record.key),
				});
				return JSON.stringify({ proposals: [] });
			},
		},
	);
	try {
		settle(f, "r", "u", keys.join(" "));
		await memory.refresh();
		expect(seen).toHaveLength(20);
		expect(
			memory.mind
				.reasoningJobs()
				.filter((job) => job.seed.stage === "deduction"),
		).toHaveLength(12);
		expect(
			memory.mind.reasoningJobs().filter((job) => job.state === "pending")
				.length,
		).toBeGreaterThan(0);
		expect(wakes.queued()).toBeGreaterThan(0);
		let rounds = 0;
		while (
			memory.mind
				.reasoningJobs()
				.some((job) => job.state === "pending" || job.state === "failed") &&
			rounds < 8
		) {
			rounds++;
			const wake = await wakes.next();
			expect(wake.delay).toBe(0);
			cycle = Promise.withResolvers();
			wake.fire();
			await cycle.promise;
		}
		expect(seen).toHaveLength(24);
		expect(new Set(seen.map((call) => call.keys.join(","))).size).toBe(12);
		expect(seen.filter((call) => call.stage === "deduction")).toHaveLength(12);
		expect(seen.filter((call) => call.stage === "induction")).toHaveLength(12);
		expect(
			memory.mind.reasoningJobs().every((job) => job.state === "committed"),
		).toBe(true);
		expect(memory.status().consolidation?.incomplete).toBe(false);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("a later refresh of unchanged evidence does not issue extra consolidation calls", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	let calls = 0;
	memory.configure(
		async () =>
			JSON.stringify([explicitObservation("u", "walking", "walking")]),
		undefined,
		{
			policy: () => policySnapshot({ maxSearchRounds: 0 }),
			modelSettingsRevision: () => 0,
			consolidate: async () => {
				calls++;
				return JSON.stringify({ proposals: [] });
			},
		},
	);
	try {
		settle(f, "r", "u", "walking");
		await memory.refresh();
		expect(calls).toBe(2);
		await memory.refresh();
		await memory.refresh();
		expect(calls).toBe(2);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("disabled engine policy never calls consolidate", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	let calls = 0;
	memory.configure(
		async () =>
			JSON.stringify([explicitObservation("u", "walking", "walking")]),
		undefined,
		{
			policy: () => policySnapshot({ enabled: false }),
			modelSettingsRevision: () => 0,
			consolidate: async () => {
				calls++;
				return JSON.stringify({ proposals: [] });
			},
		},
	);
	try {
		settle(f, "r", "u", "walking");
		await memory.refresh();
		expect(calls).toBe(0);
		expect(memory.status().consolidation?.state).toBe("disabled");
		expect(memory.mind.reasoningJobs()).toEqual([]);
		expect(memory.mind.state().records.map((record) => record.key)).toEqual([
			"walking",
		]);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("model inference cannot overwrite an existing explicit memory", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	memory.configure(
		async () => JSON.stringify([explicitObservation("u", "drink", "tea")]),
		undefined,
		{
			policy: () => policySnapshot({ maxSearchRounds: 0 }),
			modelSettingsRevision: () => 0,
			consolidate: async (text) => {
				const input = JSON.parse(text) as {
					stage: string;
					records: { id: string; revision: number; key: string }[];
				};
				const record = input.records.find((item) => item.key === "drink");
				if (!record) return JSON.stringify({ proposals: [] });
				return JSON.stringify({
					proposals: [
						{
							subject: "user",
							kind: "interest",
							key: "drink",
							text: "coffee",
							reasoningKind: input.stage,
							premises: [{ recordId: record.id, revision: record.revision }],
						},
					],
				});
			},
		},
	);
	try {
		settle(f, "r", "u", "tea");
		await memory.refresh();
		const drink = memory.mind
			.state()
			.records.find((record) => record.key === "drink");
		expect(drink?.text).toBe("tea");
		expect(drink?.evidence).toBe("explicit");
		expect(
			memory.mind.state().records.some((record) => record.text === "coffee"),
		).toBe(false);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("growth-disabled self proposals from consolidation are rejected", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
		allowCharacterGrowth: () => false,
	});
	memory.configure(
		async () =>
			JSON.stringify([explicitObservation("u", "walking", "walking")]),
		undefined,
		{
			policy: () => policySnapshot({ maxSearchRounds: 0 }),
			modelSettingsRevision: () => 0,
			consolidate: async (text) => {
				const input = JSON.parse(text) as {
					stage: string;
					records: { id: string; revision: number }[];
				};
				const record = input.records[0];
				if (!record) return JSON.stringify({ proposals: [] });
				return JSON.stringify({
					proposals: [
						{
							subject: "self",
							kind: "mood",
							key: "curious",
							text: "Curious about walking",
							reasoningKind: input.stage,
							premises: [{ recordId: record.id, revision: record.revision }],
						},
					],
				});
			},
		},
	);
	try {
		settle(f, "r", "u", "walking");
		await memory.refresh();
		expect(memory.mind.state().records.map((record) => record.subject)).toEqual(
			["user"],
		);
		expect(
			memory.mind.state().records.some((record) => record.subject === "self"),
		).toBe(false);
		expect(
			memory.mind.reasoningJobs().some((job) => job.state === "committed"),
		).toBe(false);
	} finally {
		await memory.close();
		await f.close();
	}
});
