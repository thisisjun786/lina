import { expect, test } from "bun:test";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { learnedFixture } from "../../lina-core/test/learned-source-fixture.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import type { ContextServices } from "../src/context/port.ts";
import type { LinaHost } from "../src/host.ts";
import { installPersona } from "../src/persona/hooks.ts";

test("native personal growth enters ordinary persona and disappears on source withdrawal without a world", () => {
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
	try {
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
						key: "creative.curiosity",
						text: "Exploring constellation metaphors",
						evidence: "inferred",
						sources: [
							{ entryId: `${id}-user`, quote: "tea" },
							{ entryId: `${id}-assistant`, quote: "tea" },
						],
					},
				],
			});
		}
		const host = { on() {}, registerTool() {} } as unknown as LinaHost;
		const persona = installPersona(
			host,
			agents,
			"lina",
			"BASE",
			{
				estimateText: (text: string) => text.length,
				systemTokens: 0,
			} as ContextServices,
			{
				nativeDynamics: true,
				nativeState: () => mind.state(),
				sourceLookup: f.lookup,
			},
		);
		const ready = persona.prepare();
		expect(ready.systemPrompt).toContain("Exploring constellation metaphors");
		expect(ready.systemPrompt).toContain("authored");
		f.revoke("one");
		expect(() => ready.beforeDeliver()).toThrow(/native|source|growth/i);
		expect(persona.prepare().systemPrompt).not.toContain(
			"Exploring constellation metaphors",
		);
	} finally {
		mind.close();
		agents.close();
		f.close();
	}
});

test("native persona filters user facts, respects manual evolution and expiration without revision change", () => {
	const f = learnedFixture();
	const agents = new AgentStore(join(f.root, "agents.sqlite"));
	agents.create(f.profile);
	let now = 100;
	const mind = new EngineStore(
		join(f.root, "mind.sqlite"),
		{
			version: 1,
			botId: "lina",
			sessionId: "s",
			sessionFile: join(f.root, "session.jsonl"),
			workspace: f.root,
		},
		{ lookup: f.lookup, now: () => now },
	);
	try {
		const proof = f.episode("mood");
		mind.apply({
			requestId: "mood",
			expectedRevision: 0,
			sourceProofs: proof.sourceProofs,
			observations: [
				{
					subject: "self",
					kind: "mood",
					key: "expression",
					text: "Quietly curious",
					evidence: "inferred",
					sources: [
						{ entryId: "mood-user", quote: "tea" },
						{ entryId: "mood-assistant", quote: "tea" },
					],
				},
				{
					subject: "user",
					kind: "fact",
					key: "private",
					text: "USER_PRIVATE_FACT",
					evidence: "explicit",
					sources: [{ entryId: "mood-user", quote: "tea" }],
				},
			],
		});
		const persona = installPersona(
			{ on() {}, registerTool() {} } as unknown as LinaHost,
			agents,
			"lina",
			"BASE",
			{
				estimateText: (text: string) => text.length,
				systemTokens: 0,
			} as ContextServices,
			{
				nativeDynamics: true,
				nativeState: () => mind.state(),
				sourceLookup: f.lookup,
			},
		);
		const prepared = persona.prepare();
		expect(prepared.systemPrompt).toContain("Quietly curious");
		expect(prepared.systemPrompt).toContain("provisional");
		expect(prepared.systemPrompt).not.toContain("USER_PRIVATE_FACT");
		agents.update("lina", 1, { evolution: "manual" });
		expect(persona.prepare().systemPrompt).not.toContain("Quietly curious");
		agents.update("lina", 2, { evolution: "adaptive" });
		const expiring = persona.prepare();
		const revision = mind.currentRevision();
		now += 7 * 60 * 60 * 1000;
		expect(mind.currentRevision()).toBe(revision);
		expect(() => expiring.beforeDeliver()).toThrow(/Native persona/);
		expect(persona.prepare().systemPrompt).not.toContain("Quietly curious");
	} finally {
		mind.close();
		agents.close();
		f.close();
	}
});
