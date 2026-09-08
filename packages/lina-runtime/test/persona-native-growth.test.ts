import { expect, test } from "bun:test";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { learnedFixture } from "../../lina-core/test/learned-source-fixture.ts";
import { lifeDefinition } from "../../lina-core/test/life-fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { growthSourcesCurrent } from "../src/persona/growth-source.ts";
import { NativePersonaGrowth } from "../src/persona/native-growth.ts";

function fixture() {
	const f = learnedFixture();
	const agents = new AgentStore(join(f.root, "agents.sqlite"));
	agents.create(f.profile);
	const mind = new EngineStore(
		join(f.root, "mind.sqlite"),
		{
			version: 1,
			botId: "lina",
			sessionId: "s",
			sessionFile: join(f.root, "session.jsonl"),
			workspace: f.root,
		},
		{ lookup: f.lookup },
	);
	for (const id of ["one", "two"]) {
		const proof = f.episode(id);
		mind.apply({
			requestId: id,
			expectedRevision: mind.currentRevision(),
			sourceProofs: proof.sourceProofs,
			observations: [
				{
					subject: "self",
					kind: "interest",
					key: "curiosity",
					text: "PRIVATE_SHARED_DISCUSSION",
					evidence: "inferred",
					sources: [
						{ entryId: `${id}-user`, quote: "tea" },
						{ entryId: `${id}-assistant`, quote: "tea" },
					],
				},
			],
		});
	}
	const definition = lifeDefinition(),
		source = { mind, lookup: f.lookup };
	return {
		...f,
		agents,
		mind,
		definition,
		source,
		close() {
			mind.close();
			agents.close();
			f.close();
		},
	};
}

test("personal interpretation commits once from supported native evidence and withdrawal removes its shared value", async () => {
	const f = fixture();
	let calls = 0;
	try {
		const runner = new NativePersonaGrowth({
			agents: f.agents,
			agentId: "lina",
			source: f.source,
			definition: () => f.definition,
			policy: defaultEnginePolicy,
			modelRevision: () => 1,
			interpret: async (text) => {
				calls++;
				const prompt = JSON.parse(text);
				expect(prompt.records[0].text).toBe("PRIVATE_SHARED_DISCUSSION");
				return JSON.stringify({
					traits: [
						{ axisId: "axis", value: 1, evidenceIds: [prompt.records[0].id] },
					],
					habits: [],
				});
			},
		});
		await runner.run(new AbortController().signal);
		await runner.run(new AbortController().signal);
		expect(calls).toBe(1);
		const more = f.episode("three");
		f.mind.apply({
			requestId: "three",
			expectedRevision: f.mind.currentRevision(),
			sourceProofs: more.sourceProofs,
			observations: [
				{
					subject: "self",
					kind: "interest",
					key: "curiosity",
					text: "PRIVATE_SHARED_DISCUSSION",
					evidence: "inferred",
					sources: [
						{ entryId: "three-user", quote: "tea" },
						{ entryId: "three-assistant", quote: "tea" },
					],
				},
			],
		});
		await runner.run(new AbortController().signal);
		expect(calls).toBe(1);

		const profile = f.agents.get("lina");
		if (!profile) throw Error("missing profile");
		const current = () =>
			f.agents.behavior.current("lina", f.definition.worldId, (input) =>
				growthSourcesCurrent(f.source, input, profile, f.definition),
			);
		expect(current().personalBehavior?.traits).toEqual([
			{ axisId: "axis", value: 1 },
		]);
		expect(JSON.stringify(current())).not.toContain(
			"PRIVATE_SHARED_DISCUSSION",
		);
		f.revoke("one");
		expect(current().personalBehavior).toBeNull();
	} finally {
		f.close();
	}
});

test("source revocation during interpretation refuses the result and keeps authored identity", async () => {
	const f = fixture();
	try {
		const runner = new NativePersonaGrowth({
			agents: f.agents,
			agentId: "lina",
			source: f.source,
			definition: () => f.definition,
			policy: defaultEnginePolicy,
			modelRevision: () => 1,
			interpret: async (text) => {
				const prompt = JSON.parse(text);
				f.revoke("one");
				return JSON.stringify({
					traits: [
						{ axisId: "axis", value: 1, evidenceIds: [prompt.records[0].id] },
					],
					habits: [],
				});
			},
		});
		await expect(runner.run(new AbortController().signal)).rejects.toThrow(
			/source changed/,
		);
		expect(f.agents.behavior.status("lina")[0]?.state).toBe("withheld");
		expect(f.agents.get("lina")?.profile).toBe("authored");
	} finally {
		f.close();
	}
});

test("invalid interpretation JSON records invalid_output instead of provider failure", async () => {
	const f = fixture();
	try {
		const runner = new NativePersonaGrowth({
			agents: f.agents,
			agentId: "lina",
			source: f.source,
			definition: () => f.definition,
			policy: defaultEnginePolicy,
			modelRevision: () => 1,
			interpret: async () => "{invalid",
		});
		await expect(runner.run(new AbortController().signal)).rejects.toThrow();
		expect(f.agents.behavior.status("lina")[0]?.error).toBe("invalid_output");
	} finally {
		f.close();
	}
});
