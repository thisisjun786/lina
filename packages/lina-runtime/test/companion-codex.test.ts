import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexSessionHeader } from "../../lina-codex/src/identity.ts";
import { createCodexEngine } from "../../lina-codex/src/session.ts";
import type { SourceEntry } from "../../lina-memory/src/engine/types.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import type { ContextServices } from "../src/context/port.ts";
import type { ModelControl } from "../src/models/port.ts";
import { startPersistentApp } from "../src/session-app.ts";
import {
	COMPANION_MODEL,
	createCompanionRpc,
} from "./helpers/companion-codex-rpc.ts";

type App = Awaited<ReturnType<typeof startPersistentApp>>;

function syntheticServices(episodes: SourceEntry[][]): ContextServices {
	return {
		estimateText: (text) => Math.ceil(text.length / 4),
		estimateMessages: (messages) =>
			Math.ceil(JSON.stringify(messages).length / 4),
		systemTokens: 0,
		contextWindow: 128000,
		reserveTokens: 1000,
		summarize: async () => {
			throw Error("Unexpected compaction in companion test");
		},
		prepare: () => {
			throw Error("Unexpected native compaction in companion test");
		},
		async observe(prompt, signal) {
			signal.throwIfAborted();
			const line = prompt
				.split("\n")
				.find((s) => s.startsWith("SOURCE DATA: "));
			if (!line) throw Error("Missing source projection");
			const sources = JSON.parse(
				line.slice("SOURCE DATA: ".length),
			) as SourceEntry[];
			episodes.push(sources);
			const user = sources.find(
				(s) => s.role === "user" && s.text === "I like jasmine tea.",
			);
			return JSON.stringify(
				user
					? [
							{
								subject: "user",
								kind: "preference",
								key: "drink",
								text: "Prefers jasmine tea",
								evidence: "explicit",
								sources: [{ entryId: user.entryId, quote: "jasmine tea" }],
							},
						]
					: [],
			);
		},
	};
}

const models: ModelControl = {
	catalog: () => [],
	state: () => ({
		provider: "synthetic",
		model: COMPANION_MODEL,
		settingsRevision: 1,
		error: null,
	}),
	test: async () => {
		throw Error("Unexpected model probe in companion test");
	},
};

function openCompanion(
	root: string,
	rpc: ReturnType<typeof createCompanionRpc>,
	episodes: SourceEntry[][],
) {
	return startPersistentApp({
		engine: createCodexEngine({
			services: syntheticServices(episodes),
			models,
			rpc: rpc.options,
		}),
		workspace: root,
		stateRoot: join(root, "state"),
		agentDir: join(root, "auth"),
		port: 0,
		systemPrompt: "Stable identity.",
		memoryBackend: "native",
	});
}

async function submitAndSettle(
	app: App,
	rpc: ReturnType<typeof createCompanionRpc>,
	id: string,
	text: string,
) {
	const settled = Promise.withResolvers<void>();
	const off = app.runtime.subscribe((event) => {
		if (event.type !== "snapshot") return;
		const request = event.snapshot.requests.find((r) => r.id === id);
		if (request?.status === "settled") settled.resolve();
	});
	try {
		app.runtime.submit(id, text);
		const turn = await rpc.nextTurn();
		rpc.complete(turn);
		await settled.promise;
		return turn.params;
	} finally {
		off();
	}
}

test("real Codex dialogue derives source-linked memory, injects it next turn and preserves it across restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-companion-codex-"));
	const episodes: SourceEntry[][] = [];
	let rpc = createCompanionRpc(root);
	let app: App | undefined;
	try {
		app = await openCompanion(root, rpc, episodes);
		if (!(app.memory instanceof CompanionMemory))
			throw Error("Native memory missing");
		expect(app.memory.mind.state().records).toEqual([]);
		const remembered = Promise.withResolvers<void>();
		const off = app.context.subscribe((state) => {
			if (state.memory.accepted >= 1) remembered.resolve();
		});
		try {
			const first = await submitAndSettle(
				app,
				rpc,
				"first",
				"I like jasmine tea.",
			);
			expect(JSON.stringify(first)).not.toContain("Prefers jasmine tea");
			await remembered.promise;
		} finally {
			off();
		}
		const sourceId = "codex-v2:1:companion-turn-1:user:0";
		const record = app.memory.mind.state().records[0];
		if (!record) throw Error("Accepted memory record missing");
		expect(record).toMatchObject({
			agentId: app.binding.botId,
			subject: "user",
			kind: "preference",
			text: "Prefers jasmine tea",
			evidence: "explicit",
			support: "supported",
			sources: [{ entryId: sourceId, quote: "jasmine tea" }],
			userSourceIds: [sourceId],
		});
		expect(app.runtime.store.entry(sourceId)).toMatchObject({
			role: "user",
			text: "I like jasmine tea.",
		});
		expect(episodes[0]).toContainEqual(
			expect.objectContaining({
				entryId: sourceId,
				role: "user",
				text: "I like jasmine tea.",
			}),
		);
		expect(await app.memory.recall("jasmine tea")).toContain(
			"Prefers jasmine tea",
		);
		const second = await submitAndSettle(
			app,
			rpc,
			"second",
			"What drink should I choose?",
		);
		expect(second["additionalContext"]).toMatchObject({
			"lina-context-reference": {
				kind: "untrusted",
				value: expect.stringContaining("Prefers jasmine tea"),
			},
		});
		expect(second["input"]).toEqual([
			{ type: "text", text: "What drink should I choose?", text_elements: [] },
		]);
		expect(
			JSON.stringify(rpc.requests.filter((r) => r.method === "thread/start")),
		).toContain("Stable identity.");
		await app.context.refresh();
		expect(episodes).toHaveLength(2);
		const binding = app.binding;
		const header = readCodexSessionHeader(binding.sessionFile, root);
		expect(header.nativeThreadId).toBe(rpc.threadId);
		const history = app.runtime.native.history();
		const accepted = app.context.snapshot().memory.accepted;
		expect(accepted).toBe(2);
		await app.stop();
		app = undefined;
		rpc.close();
		rpc = createCompanionRpc(root);
		app = await openCompanion(root, rpc, episodes);
		if (!(app.memory instanceof CompanionMemory))
			throw Error("Native memory missing after restart");
		await app.context.refresh();
		expect(app.binding).toEqual(binding);
		expect(readCodexSessionHeader(binding.sessionFile, root)).toEqual(header);
		expect(rpc.requests.some((r) => r.method === "thread/start")).toBe(false);
		expect(
			rpc.requests.find((r) => r.method === "thread/resume")?.params,
		).toEqual({ threadId: header.nativeThreadId });
		expect(app.runtime.native.history()).toEqual(history);
		expect(app.memory.mind.state().records).toEqual([record]);
		expect(app.memory.mind.recall("jasmine tea")).toEqual([record]);
		expect(app.runtime.store.entry(sourceId)?.text).toBe("I like jasmine tea.");
		expect(app.context.snapshot().memory.accepted).toBe(accepted);
		expect(episodes).toHaveLength(2);
		const third = await submitAndSettle(
			app,
			rpc,
			"third",
			"Do you remember my drink?",
		);
		expect(third["additionalContext"]).toMatchObject({
			"lina-context-reference": {
				kind: "untrusted",
				value: expect.stringContaining("Prefers jasmine tea"),
			},
		});
		expect(
			JSON.stringify(
				rpc.requests.filter((r) => r.method === "thread/inject_items"),
			),
		).toContain("Stable identity.");
		await app.context.refresh();
		expect(episodes).toHaveLength(3);
		expect(episodes.flat().filter((s) => s.entryId === sourceId)).toHaveLength(
			1,
		);
	} finally {
		await app?.stop();
		rpc.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Codex settled final assistant remains an observation source alongside the user", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-companion-codex-source-"));
	const episodes: SourceEntry[][] = [];
	const rpc = createCompanionRpc(root);
	let app: App | undefined;
	try {
		app = await openCompanion(root, rpc, episodes);
		await submitAndSettle(app, rpc, "first", "I like jasmine tea.");
		await app.context.refresh();
		expect(
			app.runtime.store.entry("codex-v2:1:companion-turn-1:assistant:0"),
		).toMatchObject({
			role: "assistant",
			text: "반가워요.",
		});
		expect(episodes).toHaveLength(1);
		expect(
			episodes[0]?.map(({ entryId, role, text }) => ({ entryId, role, text })),
		).toEqual([
			{
				entryId: "codex-v2:1:companion-turn-1:user:0",
				role: "user",
				text: "I like jasmine tea.",
			},
			{
				entryId: "codex-v2:1:companion-turn-1:assistant:0",
				role: "assistant",
				text: "반가워요.",
			},
		]);
	} finally {
		await app?.stop();
		rpc.close();
		rmSync(root, { recursive: true, force: true });
	}
});
