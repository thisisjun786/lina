import { dirname, join } from "node:path";
import {
	checkedDirectory,
	fsyncDirectory,
	writeExclusive,
} from "../../lina-core/src/attachments/filesystem.ts";
import type {
	LifeModelRequest,
	LifeModelUsage,
} from "../../lina-core/src/world/autonomy-types.ts";
import {
	assertAuthorFiles,
	verifyAuthorNative,
	verifyAuthorThread,
} from "./author-native-checks.ts";
import {
	AUTHOR_PROFILE,
	type AuthorNativePlan,
	authorConfig,
	authorRecord,
} from "./author-native-policy.ts";
import type { LifeModelGateway } from "./life-model-gateway.ts";
import { lifeRpcOptions } from "./life-model-policy.ts";
import {
	LIFE_UNKNOWN_USAGE,
	lifeString,
	lifeUsage,
} from "./life-model-validation.ts";
import { nativeEffort, requireListedModel } from "./model.ts";
import { createCodexRpc } from "./rpc.ts";

/** Closers remain retained on failure, including an asynchronous child-open race. */
export class LifeNativeOwnership {
	private readonly closers = new Set<() => Promise<void>>();
	retain(close: () => Promise<void>): () => Promise<void> {
		const release = async () => {
			await close();
			this.closers.delete(release);
		};
		this.closers.add(release);
		return release;
	}
	async close(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.closers].map((close) => close()),
		);
		const failed = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (failed.length)
			throw new AggregateError(
				failed.map((r) => r.reason),
				"LIFE owned teardown failed",
			);
	}
}
export function bindLifeNative(
	original: AuthorNativePlan,
	root: string,
	gate: Pick<LifeModelGateway, "baseUrl">,
): AuthorNativePlan {
	checkedDirectory(root, true);
	const home = checkedDirectory(join(root, "home"), true),
		workspace = checkedDirectory(join(root, "workspace"), true);
	const plan = {
		...original,
		root,
		home,
		workspace,
		selection: {
			...original.selection,
			connection: {
				...original.selection.connection,
				baseUrl: gate.baseUrl,
				requiresAdmissionToken: true,
			},
		},
	};
	// Native files are data, never the authoritative parent journal.
	for (const [name, text] of [
		["config.toml", authorConfig(plan)],
		["models.json", JSON.stringify({ models: [plan.metadata] })],
	] as const) {
		// Preserve exact TOML/catalog bytes; both require exclusive fsynced writes.
		writeNativeFile(join(home, name), text);
	}
	return plan;
}

function writeNativeFile(path: string, text: string): void {
	writeExclusive(path, Buffer.from(text));
	fsyncDirectory(dirname(path));
}

export async function runLifeNative(options: {
	plan: AuthorNativePlan;
	request: LifeModelRequest;
	nonce: string;
	signal: AbortSignal;
	ownership: LifeNativeOwnership;
	onBinding?: (value: { threadId: string; pid: number | undefined }) => void;
}): Promise<{
	threadId: string;
	turnId: string;
	text: string;
	usage: LifeModelUsage;
}> {
	const { plan, request, signal } = options;
	signal.throwIfAborted();
	assertAuthorFiles(plan, authorConfig(plan));
	const opening = createCodexRpc(lifeRpcOptions(plan, options.nonce));
	const release = options.ownership.retain(async () => {
		await (await opening).close();
	});
	const rpc = await opening;
	const done = Promise.withResolvers<void>();
	void done.promise.catch(() => undefined);
	let threadId = "",
		turnId = "",
		streamedBytes = 0;
	let usage = { ...LIFE_UNKNOWN_USAGE };
	const messages = new Map<string, string>();
	const fail = () =>
		done.reject(Error("LIFE native tool, identity or transport violation"));
	const abort = () => done.reject(Error("LIFE native request cancelled"));
	signal.addEventListener("abort", abort, { once: true });
	rpc.onRequest(async () => {
		fail();
		throw Error("LIFE native actions are forbidden");
	});
	rpc.subscribe((method, params) => {
		try {
			if (method === "eof" || method === "error") {
				fail();
				return;
			}
			if (
				!method.startsWith("item/") &&
				!method.startsWith("turn/") &&
				method !== "thread/tokenUsage/updated"
			)
				return;
			const p = authorRecord(params);
			if (p["threadId"] !== threadId) throw Error("Foreign LIFE native thread");
			const turn =
				method === "turn/started" || method === "turn/completed"
					? authorRecord(p["turn"])
					: null;
			const id = lifeString(turn ? turn["id"] : p["turnId"]);
			if (turnId && turnId !== id) throw Error("Foreign LIFE native turn");
			turnId = id;
			if (method === "thread/tokenUsage/updated") {
				const total = authorRecord(authorRecord(p["tokenUsage"])["total"]);
				usage = lifeUsage({
					inputTokens: total["inputTokens"],
					outputTokens: total["outputTokens"],
					totalTokens: total["totalTokens"],
				});
			}
			if (method === "item/agentMessage/delta") {
				if (typeof p["delta"] !== "string") throw Error("Invalid LIFE delta");
				streamedBytes += Buffer.byteLength(p["delta"]);
				if (streamedBytes > request.limits.maxOutputBytes)
					throw Error("LIFE output byte bound");
			}
			if (method === "item/started" || method === "item/completed") {
				const item = authorRecord(p["item"]);
				if (
					!["userMessage", "agentMessage", "reasoning"].includes(
						String(item["type"]),
					)
				)
					throw Error("LIFE native tool attempt");
				if (method === "item/completed" && item["type"] === "agentMessage") {
					if (typeof item["text"] !== "string")
						throw Error("Invalid LIFE message");
					messages.set(lifeString(item["id"]), item["text"]);
					if (
						Buffer.byteLength([...messages.values()].join("\n")) >
						request.limits.maxOutputBytes
					)
						throw Error("LIFE output byte bound");
				}
			}
			if (method === "turn/completed") {
				if (turn?.["status"] === "completed") done.resolve();
				else fail();
			}
		} catch {
			fail();
		}
	});
	try {
		signal.throwIfAborted();
		await rpc.request(
			"initialize",
			{
				clientInfo: { name: "lina-life-model", version: "1" },
				capabilities: { experimentalApi: true },
			},
			signal,
		);
		rpc.notify("initialized");
		await verifyAuthorNative(rpc, plan);
		signal.throwIfAborted();
		const catalog = await rpc.request("model/list", {}, signal);
		requireListedModel(catalog, request.model);
		const effort = nativeEffort(
			catalog,
			request.model,
			plan.selection.selected.reasoning,
		);
		const bound = await rpc.request(
			"thread/start",
			{
				...AUTHOR_PROFILE,
				cwd: plan.workspace,
				model: request.model,
				modelProvider: request.provider,
				allowProviderModelFallback: false,
				personality: "none",
				ephemeral: true,
				baseInstructions: request.systemPrompt,
				developerInstructions: "",
				dynamicTools: [],
				runtimeWorkspaceRoots: [],
			},
			signal,
		);
		verifyAuthorThread(bound, plan);
		threadId = lifeString(authorRecord(authorRecord(bound)["thread"])["id"]);
		options.onBinding?.({ threadId, pid: rpc.pid });
		signal.throwIfAborted();
		assertAuthorFiles(plan, authorConfig(plan));
		const started = authorRecord(
			await rpc.request(
				"turn/start",
				{
					threadId,
					input: [{ type: "text", text: request.input }],
					...(effort ? { effort } : {}),
				},
				signal,
			),
		);
		const startedId = lifeString(authorRecord(started["turn"])["id"]);
		if (turnId && turnId !== startedId)
			throw Error("LIFE native turn identity changed");
		turnId = startedId;
		await done.promise;
		signal.throwIfAborted();
		return { threadId, turnId, text: [...messages.values()].join("\n"), usage };
	} finally {
		signal.removeEventListener("abort", abort);
		await release();
	}
}
