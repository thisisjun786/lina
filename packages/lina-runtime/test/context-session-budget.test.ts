import { expect, test } from "bun:test";
import { join } from "node:path";
import { createCodexEngine } from "../../lina-codex/src/session.ts";
import { contextRpc } from "../../lina-codex/test/context-policy-rpc.ts";
import {
	settled,
	sourceFixture,
} from "../../lina-codex/test/source-provenance-fixture.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { worldServices } from "./world-fixture.ts";

test("SessionApp forwards its saved context policy to actual summary and ordinary turn input", async () => {
	const f = sourceFixture(),
		rpc = contextRpc(f.root),
		caps: number[] = [],
		inputs: string[] = [];
	let app: Awaited<ReturnType<typeof startPersistentApp>> | undefined;
	const policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			leafInputTokens: 500,
			leafOutputTokens: 80,
			condensedOutputTokens: 40,
			refreshThresholdTokens: 1,
			freshTailEntries: 1,
		},
	};
	try {
		app = await startPersistentApp({
			engine: createCodexEngine({
				models: f.options.models,
				rpc: rpc.options,
				services: {
					...worldServices(),
					estimator: conservativeEstimator,
					estimateText: conservativeEstimator.text,
					estimateMessages: conservativeEstimator.messages,
					summaryCacheKey: () => "session-summary",
					summarize: async (text, cap, _signal, guard) => {
						guard?.();
						inputs.push(text);
						caps.push(cap);
						return "ARCHIVE_DECISION_B";
					},
				},
			}),
			enginePolicy: () => policy,
			workspace: f.root,
			stateRoot: join(f.root, "app"),
			agentDir: f.root,
			systemPrompt: "Assistant",
			memoryBackend: "disabled",
			port: 0,
		});
		for (const [id, text] of [
			["old-a", "Old A and reason."],
			["old-b", "Decision B replaces A."],
			["tail", "Recent original promise."],
		] as const)
			appendContextEntry(app.runtime.store, app.binding.sessionId, {
				entryId: id,
				role: "user",
				text,
				timestamp: "2026-09-08T00:00:00Z",
				raw: {},
			});
		const done = settled(app.runtime, "budget-turn");
		app.runtime.submit("budget-turn", "hello");
		const frame = await rpc.next("turn/start");
		expect(JSON.stringify(frame)).toContain("ARCHIVE_DECISION_B");
		expect(caps.length).toBeGreaterThan(0);
		expect(caps.every((cap) => cap <= 80)).toBe(true);
		expect(caps).toContain(40);
		expect(
			inputs.every((input) => conservativeEstimator.text(input) <= 500),
		).toBe(true);
		expect(
			inputs.every((input) => !input.includes("Recent original promise")),
		).toBe(true);
		const thread = rpc.threads.at(-1);
		if (!thread) throw Error("thread missing");
		rpc.complete(thread.id);
		await done;
	} finally {
		await app?.stop();
		rpc.close();
		await f.close();
	}
});
