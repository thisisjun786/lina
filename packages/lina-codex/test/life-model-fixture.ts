import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifeModelRequest } from "../../lina-core/src/world/autonomy-types.ts";
import type { IsolatedHomeConnection } from "../../lina-opencodex/src/hub.ts";
import { authorRecord } from "../src/author-native-policy.ts";

export const lifeMetadata = {
	slug: "life-probe",
	display_name: "Synthetic LIFE",
	description: "Local only",
	base_instructions: "UNSELECTED_METADATA_INSTRUCTIONS",
	supported_reasoning_levels: [],
	default_reasoning_level: null,
	shell_type: "unified_exec",
	priority: 0,
	support_verbosity: false,
	truncation_policy: { mode: "bytes", limit: 100000 },
	experimental_supported_tools: [],
	context_window: 32000,
	input_modalities: ["text"],
	visibility: "list",
	supported_in_api: true,
};
export function lifeRequest(
	overrides: Partial<LifeModelRequest> = {},
): LifeModelRequest {
	return {
		version: 1,
		id: randomUUID(),
		worldId: "world",
		stepId: "step",
		lane: "actor",
		agentId: "lina",
		provider: "opencodex",
		model: lifeMetadata.slug,
		modelSettingsRevision: 7,
		systemPrompt: "SCOPED_SYSTEM",
		input: "LINA_PRIVATE_OBSERVATION",
		limits: {
			maxInputTokens: 4096,
			maxOutputTokens: 1024,
			maxInputBytes: 16384,
			maxOutputBytes: 16384,
			timeoutMs: 15000,
		},
		...overrides,
	};
}
export function lifeResponse(
	text = '{"choice":"quiet"}',
	usage: unknown = { input_tokens: 31, output_tokens: 7, total_tokens: 38 },
	tool?: string,
): Response {
	const item = tool
		? {
				id: randomUUID(),
				type: "function_call",
				call_id: randomUUID(),
				name: tool.startsWith("skills.") ? tool.slice(7) : tool,
				...(tool.startsWith("skills.") ? { namespace: "skills" } : {}),
				arguments: JSON.stringify(
					tool === "skills.list"
						? { authority: { kind: "orchestrator" } }
						: tool === "skills.read"
							? { package: "missing-synthetic-package" }
							: {},
				),
			}
		: {
				id: randomUUID(),
				type: "message",
				role: "assistant",
				status: "completed",
				phase: "final_answer",
				content: [{ type: "output_text", text, annotations: [] }],
			};
	const response = {
		id: randomUUID(),
		object: "response",
		created_at: 1,
		status: "completed",
		output: [item],
		...(usage === null ? {} : { usage }),
	};
	return new Response(
		[
			{
				type: "response.created",
				response: { ...response, status: "in_progress", output: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...item, content: [] },
			},
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response },
		]
			.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
export function lifeFixture(
	respond: (request: Request) => Response | Promise<Response> = () =>
		lifeResponse(),
) {
	const root = mkdtempSync(join(tmpdir(), "lina-life-model-"));
	const captures: Array<{
		body: Record<string, unknown>;
		authorization: string | null;
	}> = [];
	const entered = Promise.withResolvers<void>();
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			captures.push({
				body: authorRecord(await request.clone().json()),
				authorization: request.headers.get("authorization"),
			});
			entered.resolve();
			return respond(request);
		},
	});
	const connection: IsolatedHomeConnection = {
		origin: provider.url.origin,
		baseUrl: `${provider.url.origin}/v1`,
		catalogJson: JSON.stringify({ models: [lifeMetadata] }),
		catalogSource: "hub",
		requiresAdmissionToken: true,
		tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
		providerTable: "UNTRUSTED_PROVIDER_TABLE",
	};
	const selection = {
		connection,
		selected: {
			id: "life",
			provider: "opencodex",
			model: lifeMetadata.slug,
			reasoning: "off" as const,
		},
		settingsRevision: 7,
	};
	return {
		root,
		captures,
		entered: entered.promise,
		selection,
		options: {
			stateRoot: root,
			selection: () => selection,
			providerEnv: () => ({
				OPENCODEX_API_AUTH_TOKEN: "synthetic-parent-credential",
			}),
		},
		async close() {
			await provider.stop(true);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
