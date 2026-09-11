import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@code-yeongyu/senpi";
import { Type } from "typebox";
import { z } from "zod";
import { applyEffect } from "./owner.ts";
import { commandSchema } from "./protocol.ts";

const [root, endpoint, file] = z
	.tuple([z.string(), z.url(), z.string()])
	.parse(process.argv.slice(2));
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
function send(
	kind: "ready" | "done" | "aborted" | "effect" | "event" | "error",
	data: unknown,
) {
	if (!process.send) throw new Error("Worker requires IPC");
	process.send({ kind, data });
}
let currentPolicy = "old-policy";
const resourceLoader: ResourceLoader = {
	getExtensions: () => ({
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	}),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `QA_POLICY=${currentPolicy}`,
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => undefined,
	reload: async () => undefined,
};
const runtime = await ModelRuntime.create({
	agentDir,
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
	modelsStorePath: join(agentDir, "models-store.json"),
	allowModelNetwork: false,
	refreshOnCreate: false,
});
await runtime.registerProvider(
	"qa-loopback",
	{
		baseUrl: endpoint,
		api: "openai-completions",
		apiKey: "synthetic-loopback-only",
		models: [
			{
				id: "fixture-model",
				name: "Synthetic fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 256,
			},
		],
	},
	{ refresh: false },
);
const model = runtime.getModel("qa-loopback", "fixture-model");
if (!model) throw new Error("Explicit fixture model missing");
let crashArmed = false;
const fenced = z
	.boolean()
	.parse(JSON.parse(readFileSync(join(root, "fenced.json"), "utf8")));
const effectGate = Promise.withResolvers<void>();
const tool = defineTool({
	name: "fixture_effect",
	label: "Fixture effect",
	description: "Read a synthetic owner's result.",
	parameters: Type.Object({ operationId: Type.String() }),
	async execute(_callId, params) {
		const operation = {
			operationId: params.operationId,
			result: readFileSync(join(root, "owner-value.txt"), "utf8"),
		};
		const receipt = applyEffect(root, operation, fenced);
		const result = receipt.result;
		appendFileSync(
			join(root, "tool-calls.jsonl"),
			`${JSON.stringify({ operationId: params.operationId, result })}\n`,
		);
		if (crashArmed) {
			send("effect", receipt);
			await effectGate.promise;
		}
		return {
			content: [{ type: "text", text: result }],
			details: { operationId: params.operationId },
		};
	},
});
const manager = file
	? SessionManager.open(file, join(root, "sessions"), cwd)
	: SessionManager.create(cwd, join(root, "sessions"));
const { session } = await createAgentSession({
	cwd,
	agentDir,
	model,
	modelRuntime: runtime,
	resourceLoader,
	tools: ["fixture_effect"],
	customTools: [tool],
	scopedModels: [],
	favoriteModels: [],
	sessionManager: manager,
	thinkingLevel: "off",
	autoTitleSessions: false,
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: {
			enabled: false,
			maxRetries: 0,
			modelFallback: false,
			provider: { maxRetries: 0 },
		},
		promptCache: { keepAlive: { enabled: false } },
		enableAnalytics: false,
		enableInstallTelemetry: false,
		experimental: { sharedHost: false },
	}),
});
const events: string[] = [];
session.subscribe((event) => {
	events.push(event.type);
	appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`);
	send("event", event.type);
});
function snapshot() {
	return {
		pid: process.pid,
		file: manager.getSessionFile(),
		streaming: session.isStreaming,
		messages: session.messages,
		events,
	};
}
process.on("message", (raw: unknown) => {
	async function handle() {
		const command = commandSchema.parse(raw);
		switch (command.kind) {
			case "prompt":
				await session.prompt(command.text);
				send("done", snapshot());
				return;
			case "correct":
				currentPolicy = command.policy;
				await session.reload();
				await session.prompt(`QA_CORRECTION=${command.policy}`);
				send("done", snapshot());
				return;
			case "crash":
				crashArmed = true;
				await session.prompt("QA_REQUEST=crash");
				throw new Error("Crash gate unexpectedly released");
			case "abort":
				await session.abort();
				send("aborted", snapshot());
				return;
			case "close":
				session.dispose();
				if (!process.disconnect) throw new Error("Worker IPC unavailable");
				process.disconnect();
				return;
		}
	}
	void handle().catch((error: unknown) => {
		send("error", error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
});
send("ready", snapshot());
