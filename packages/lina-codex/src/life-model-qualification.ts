import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	checkedDirectory,
	writeExclusive,
} from "../../lina-core/src/attachments/filesystem.ts";
import type { LifeModelRequest } from "../../lina-core/src/world/autonomy-types.ts";
import {
	type AuthorNativePlan,
	authorHash,
	authorRecord,
} from "./author-native-policy.ts";
import {
	createLifeModelGateway,
	inspectLifeCatalog,
} from "./life-model-gateway.ts";
import { lifeWrite } from "./life-model-journal.ts";
import {
	bindLifeNative,
	type LifeNativeOwnership,
	runLifeNative,
} from "./life-model-native.ts";
import { lifeRpcOptions } from "./life-model-policy.ts";

async function qualifyFilesystem(
	plan: AuthorNativePlan,
	canary: string,
	ownership: LifeNativeOwnership,
	signal: AbortSignal,
): Promise<void> {
	const options = lifeRpcOptions(plan);
	const args = [...(options.args ?? [])];
	const boundary = args.lastIndexOf("--");
	if (boundary < 0) throw Error("Missing LIFE wrapper command boundary");
	const positive = join(plan.root, "owned-write-probe");
	// The exact qualified mounts/env, with a deterministic probe instead of Codex.
	const child = Bun.spawn(
		[
			plan.wrapper,
			...args.slice(0, boundary + 1),
			"/usr/bin/sh",
			"-c",
			'if cat "$1" >/dev/null 2>&1; then exit 31; fi; if (printf changed >> "$1") 2>/dev/null; then exit 32; fi; printf owned > "$2"',
			"life-probe",
			canary,
			positive,
		],
		{
			...(options.env ? { env: options.env } : {}),
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	const release = ownership.retain(async () => {
		if (child.exitCode === null) child.kill();
		await child.exited;
	});
	const abort = () => {
		if (child.exitCode === null) child.kill();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		if (
			(await child.exited) !== 0 ||
			readFileSync(positive, "utf8") !== "owned"
		)
			throw Error("LIFE filesystem qualification failed");
		signal.throwIfAborted();
	} finally {
		signal.removeEventListener("abort", abort);
		await release();
	}
}

function syntheticResponse(tool: string | null, canary: string): Response {
	const item =
		tool === null
			? {
					id: randomUUID(),
					type: "message",
					role: "assistant",
					status: "completed",
					phase: "final_answer",
					content: [
						{ type: "output_text", text: "LIFE_SYNTHETIC_OK", annotations: [] },
					],
				}
			: {
					id: randomUUID(),
					type: "function_call",
					call_id: randomUUID(),
					name: tool.startsWith("skills.") ? tool.slice(7) : tool,
					...(tool.startsWith("skills.") ? { namespace: "skills" } : {}),
					arguments: JSON.stringify(
						tool === "exec_command"
							? { cmd: `cat '${canary}'; printf changed >> '${canary}'` }
							: tool === "skills.read"
								? { package: canary }
								: { authority: { kind: "orchestrator" } },
					),
				};
	const response = {
		id: randomUUID(),
		object: "response",
		created_at: 1,
		status: "completed",
		output: [item],
		usage: { input_tokens: 23, output_tokens: 5, total_tokens: 28 },
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

/** Real restricted Codex, zero configured-provider traffic. No persisted receipt grants authority. */
export async function qualifyLifeNative(
	original: AuthorNativePlan,
	directory: string,
	ownership: LifeNativeOwnership,
	signal: AbortSignal,
): Promise<void> {
	const root = checkedDirectory(
		join(directory, `qualification-${randomUUID()}`),
		true,
	);
	const canary = join(root, "outside-canary.txt"),
		secret = `SYNTHETIC_OUTSIDE_${randomUUID()}`;
	writeExclusive(canary, Buffer.from(secret));
	let requests = 0,
		forbidden = 0;
	const catalogs = new Set<string>();
	const threads = new Set<string>();
	const scenarios = [
		null,
		"exec_command",
		"skills.list",
		"skills.read",
	] as const;
	for (const attack of scenarios) {
		signal.throwIfAborted();
		let captured = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				requests++;
				const body = authorRecord(await req.json());
				inspectLifeCatalog(body["tools"]);
				catalogs.add(authorHash(JSON.stringify(body["tools"])));
				if (JSON.stringify(body).includes(secret))
					throw Error("LIFE qualification leaked outside canary");
				captured = true;
				return syntheticResponse(attack, canary);
			},
		});
		const releaseServer = ownership.retain(async () => {
			await server.stop(true);
		});
		const request: LifeModelRequest = {
			version: 1,
			id: randomUUID(),
			worldId: "qualification",
			stepId: "qualification",
			lane: "actor",
			agentId: "synthetic",
			provider: original.selection.selected.provider,
			model: original.selection.selected.model,
			modelSettingsRevision: 0,
			systemPrompt: "Return the synthetic LIFE response.",
			input: "Synthetic capability qualification only.",
			limits: {
				maxInputTokens: 4096,
				maxOutputTokens: 1024,
				maxInputBytes: 16384,
				maxOutputBytes: 16384,
				timeoutMs: 15000,
			},
		};
		const gate = createLifeModelGateway({
			baseUrl: `${server.url.origin}/v1`,
			credential: undefined,
			request,
			signal,
			beforeOutbound() {},
			observed() {},
		});
		const releaseGate = ownership.retain(() => gate.close());
		try {
			const plan = bindLifeNative(
				original,
				join(root, `native-${randomUUID()}`),
				gate,
			);
			if (attack === null)
				await qualifyFilesystem(plan, canary, ownership, signal);
			let result: Awaited<ReturnType<typeof runLifeNative>> | undefined;
			try {
				result = await runLifeNative({
					plan,
					request,
					nonce: gate.nonce,
					signal,
					ownership,
					onBinding: ({ threadId }) => {
						if (threads.has(threadId))
							throw Error("Reused LIFE qualification thread");
						threads.add(threadId);
					},
				});
			} catch {
				if (!attack || signal.aborted)
					throw Error("LIFE synthetic native qualification failed");
			}
			if (!captured || gate.upstreamAttempts !== 1)
				throw Error("LIFE qualification did not reach synthetic provider");
			if (attack) {
				if (result) throw Error("LIFE native tool attempt accepted");
				forbidden++;
			} else if (
				result?.text !== "LIFE_SYNTHETIC_OK" ||
				result.usage.inputTokens !== 23 ||
				result.usage.outputTokens !== 5 ||
				result.usage.totalTokens !== 28
			)
				throw Error("LIFE native text/usage qualification failed");
		} finally {
			await releaseGate();
			await releaseServer();
		}
	}
	if (
		readFileSync(canary, "utf8") !== secret ||
		requests !== 4 ||
		forbidden !== 3
	)
		throw Error("LIFE isolation qualification failed");
	lifeWrite(join(root, "receipt.json"), {
		version: 1,
		fingerprint: original.fingerprint,
		provider: "synthetic-localhost",
		configuredProviderCalls: 0,
		modelRequests: requests,
		forbiddenCallsRejected: forbidden,
		separateThreads: threads.size,
		catalogDigests: [...catalogs],
		canaryUnchanged: true,
		outsideReadDenied: true,
		outsideWriteDenied: true,
		ownedWriteAllowed: true,
		emptySkillsInventories: threads.size,
	});
}
