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
