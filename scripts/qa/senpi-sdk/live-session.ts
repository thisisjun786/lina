import { join } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@code-yeongyu/senpi";
import { z } from "zod";

export async function createLiveSession(options: {
	readonly scratch: string;
	readonly baseUrl: string;
	readonly tool: ToolDefinition;
}) {
	const { scratch, baseUrl, tool } = options;
	const runtime = await ModelRuntime.create({
		agentDir: join(scratch, "agent"),
		authPath: join(scratch, "agent", "auth.json"),
		modelsPath: join(scratch, "agent", "models.json"),
		modelsStorePath: join(scratch, "agent", "store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await runtime.registerProvider(
		"lina-live-probe",
		{
			baseUrl: baseUrl,
			api: "openai-responses",
			apiKey: "synthetic-capture-only",
			models: [
				{
					id: "ollama-cloud/glm-5.3-flash",
					name: "GLM live probe",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				},
			],
		},
		{ refresh: false },
	);
	const model = runtime.getModel(
		"lina-live-probe",
		"ollama-cloud/glm-5.3-flash",
	);
	if (!model) throw new Error("Explicit live model missing");
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
		getSystemPrompt: () =>
			"You are an inventory assistant. Follow the latest user request. Use lookup_inventory only when asked. Never invent inventory or receipts. When asked for JSON, return only an object with warehouse, sku, quantity, receipt from the tool result.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => undefined,
		reload: async () => undefined,
	};
	const created = await createAgentSession({
		cwd: join(scratch, "workspace"),
		agentDir: join(scratch, "agent"),
		model,
		modelRuntime: runtime,
		resourceLoader,
		tools: ["lookup_inventory"],
		customTools: [tool],
		scopedModels: [],
		favoriteModels: [],
		thinkingLevel: "off",
		autoTitleSessions: false,
		sessionManager: SessionManager.create(
			join(scratch, "workspace"),
			join(scratch, "sessions"),
		),
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
	return created.session;
}

export function assistantText(message: unknown): string {
	const parsed = z
		.object({
			role: z.literal("assistant"),
			content: z.array(
				z.object({ type: z.string(), text: z.string().optional() }),
			),
		})
		.safeParse(message);
	if (!parsed.success) return "";
	return parsed.data.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}
