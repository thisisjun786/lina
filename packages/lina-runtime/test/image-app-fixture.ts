import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type {
	CodexRpc,
	CodexRpcRequestHandler,
} from "../../lina-codex/src/rpc.ts";
import {
	type CodexSession,
	createCodexEngine,
	createCodexSession,
} from "../../lina-codex/src/session.ts";
import type { SessionSnapshot } from "../../lina-core/src/protocol.ts";
import type { ContextServices } from "../src/context/port.ts";
import type { ModelControl } from "../src/models/port.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { catalog, terminal } from "./ima2-client-fixture.ts";

// Deterministic 320x200 RGB PNGs, generated locally without an image provider.
function solidPng(
	rgb: readonly [number, number, number],
): Uint8Array<ArrayBuffer> {
	const width = 320,
		height = 200;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const chunk = (type: string, data: Uint8Array) => {
		const result = Buffer.alloc(data.length + 12);
		result.writeUInt32BE(data.length, 0);
		result.write(type, 4, 4, "ascii");
		result.set(data, 8);
		let crc = 0xffffffff;
		for (const byte of result.subarray(4, -4)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++)
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
		return result;
	};
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", new Uint8Array()),
		]),
	);
}
export const GENERATED_PNG = solidPng([53, 93, 167]);
export const EDITED_PNG = solidPng([53, 127, 105]);

type GenerateBody = {
	requestId: string;
	provider: string;
	model: string;
	prompt: string;
	async: boolean;
	n: number;
	format: string;
	references: string[];
};
type ToolReply = {
	success: boolean;
	contentItems: Array<{ type: "inputText"; text: string }>;
};
const MODEL = "synthetic-image-driver";

function startIma2Fixture() {
	const submissions: Array<{
		body: GenerateBody;
		idempotencyKey: string | null;
	}> = [];
	const downloads: string[] = [];
	const outputs = new Map<string, Uint8Array>();
	const terminalJobs: ReturnType<typeof terminal>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/health")
				return Response.json({ ok: true, version: "3.14.0" });
			if (url.pathname === "/api/models") return Response.json(catalog);
			if (url.pathname === "/api/generate" && request.method === "POST") {
				const body = (await request.json()) as GenerateBody;
				submissions.push({
					body,
					idempotencyKey: request.headers.get("Idempotency-Key"),
				});
				const filename = `${body.requestId}.png`;
				const failed = body.prompt.includes("fail");
				terminalJobs.push({
					...terminal(
						failed ? "failed" : "completed",
						failed ? {} : { filenames: [filename], imageCount: 1 },
					),
					requestId: body.requestId,
				});
				if (!failed)
					outputs.set(
						filename,
						body.references.length ? EDITED_PNG : GENERATED_PNG,
					);
				return Response.json(
					{ requestId: body.requestId, async: true },
					{ status: 202 },
				);
			}
			if (url.pathname === "/api/inflight")
				return Response.json({ jobs: [], terminalJobs });
			if (url.pathname.startsWith("/generated/")) {
				const filename = url.pathname.slice("/generated/".length);
				const bytes = outputs.get(filename);
				if (bytes) {
					downloads.push(filename);
					return new Response(bytes, {
						headers: { "Content-Type": "image/png" },
					});
				}
			}
			return new Response("Unknown synthetic ima2 route", { status: 404 });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		submissions,
		downloads,
		stop: () => server.stop(true),
	};
}

class ImageCodexRpc implements CodexRpc {
	closed = false;
	readonly pid = undefined;
	readonly methods: string[] = [];
	readonly calls: Array<{
		tool: string;
		arguments: unknown;
		result: ToolReply;
	}> = [];
	readonly failures: unknown[] = [];
	private threadId: string = randomUUID();
	private readonly listeners = new Set<
		(method: string, params: unknown) => void
	>();
	private readonly handlers = new Set<CodexRpcRequestHandler>();
	private readonly pending = new Set<Promise<void>>();

	async request<T>(method: string, params?: unknown): Promise<T> {
		if (this.closed) throw Error("Synthetic RPC closed");
		this.methods.push(method);
		return this.reply(method, params) as T;
	}
	private reply(method: string, params: unknown): unknown {
		if (method === "initialize") return { userAgent: "image-qa" };
		if (method === "model/list") return { data: [{ id: MODEL, model: MODEL }] };
		if (method === "skills/list") return { data: [] };
		if (method === "thread/resume")
			this.threadId = (params as { threadId: string }).threadId;
		if (["thread/start", "thread/resume", "thread/read"].includes(method)) {
			// Empty native history makes the adapter's actual persisted journal the only replay source.
			return {
				thread: {
					id: this.threadId,
					turns: [],
					modelProvider: "synthetic",
					status: { type: "idle" },
				},
			};
		}
		if (
			[
				"thread/name/set",
				"thread/inject_items",
				"skills/extraRoots/set",
			].includes(method)
		)
			return {};
		if (method === "turn/start") {
			const text = (params as { input: Array<{ text: string }> }).input
				.map((part) => part.text)
				.join("\n");
			const turnId = randomUUID();
			const task = this.turn(turnId, text)
				.catch((error: unknown) => {
					this.failures.push(error);
					this.emit("eof", {
						message:
							error instanceof Error ? error.message : "Synthetic RPC failed",
					});
				})
				.finally(() => this.pending.delete(task));
			this.pending.add(task);
			return { turn: { id: turnId, items: [], status: "inProgress" } };
		}
		if (method === "turn/interrupt") {
			this.emit("turn/completed", {
				threadId: this.threadId,
				turn: {
					id: (params as { turnId: string }).turnId,
					items: [],
					status: "interrupted",
				},
			});
			return {};
		}
		throw Error(`Unexpected synthetic RPC method: ${method}`);
	}
	private emit(method: string, params: unknown): void {
		for (const listener of this.listeners) listener(method, params);
	}
	private async tool(
		turnId: string,
		tool: string,
		args: unknown,
	): Promise<ToolReply> {
		const handler = [...this.handlers][0];
		if (!handler) throw Error("Codex adapter did not register its RPC handler");
		const callId = randomUUID();
		const result = (await handler("item/tool/call", {
			threadId: this.threadId,
			turnId,
			callId,
			tool,
			arguments: args,
		})) as ToolReply;
		this.calls.push({ tool, arguments: args, result });
		this.emit("item/completed", {
			threadId: this.threadId,
			turnId,
			item: {
				id: callId,
				type: "dynamicToolCall",
				tool,
				arguments: args,
				...result,
			},
		});
		return result;
	}
	private async turn(turnId: string, text: string): Promise<void> {
		const frame = { threadId: this.threadId, turnId };
		this.emit("turn/started", {
			...frame,
			turn: { id: turnId, items: [], status: "inProgress" },
		});
		this.emit("item/completed", {
			...frame,
			item: {
				id: randomUUID(),
				type: "userMessage",
				content: [{ type: "text", text, text_elements: [] }],
			},
		});
		const args = { provider: "api", model: "image-model", prompt: text };
		let result: ToolReply;
		if (/\bedit\b/i.test(text)) {
			const listing = await this.tool(turnId, "lina_image_jobs", {});
			if (!listing.success) throw Error("Image job listing failed");
			const jobs = JSON.parse(listing.contentItems[0]?.text ?? "{}") as {
				jobs: Array<{ artifact: { id: string } | null }>;
			};
			const source = jobs.jobs.findLast(
				(job) => job.artifact !== null,
			)?.artifact;
			if (!source) throw Error("Generate an image before editing");
			result = await this.tool(turnId, "lina_image_edit", {
				...args,
				sourceArtifactId: source.id,
			});
		} else result = await this.tool(turnId, "lina_image_generate", args);
		this.emit("item/completed", {
			...frame,
			item: {
				id: randomUUID(),
				type: "agentMessage",
				text: result.success
					? "이미지 작업을 처리했습니다."
					: "이미지 작업에 실패했습니다.",
				phase: "final_answer",
			},
		});
		this.emit("turn/completed", {
			threadId: this.threadId,
			turn: { id: turnId, items: [], status: "completed" },
		});
	}
	notify(): void {}
	subscribe(listener: (method: string, params: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	onRequest(handler: CodexRpcRequestHandler): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all(this.pending);
	}
}

const services: ContextServices = {
	estimateText: (text) => Math.ceil(text.length / 4),
	estimateMessages: (messages) =>
		Math.ceil(JSON.stringify(messages).length / 4),
	systemTokens: 0,
	contextWindow: 128000,
	reserveTokens: 1000,
	summarize: async () => {
		throw Error("Unexpected summarization in image QA");
	},
	prepare: () => {
		throw Error("Unexpected compaction in image QA");
	},
};
const models: ModelControl = {
	catalog: () => [],
	state: () => ({
		provider: "synthetic",
		model: MODEL,
		settingsRevision: 1,
		error: null,
	}),
	test: async () => {
		throw Error("External model calls are disabled in image QA");
	},
};

export async function createImageAppFixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-app-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	for (const dir of [workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });
	const ima2 = startIma2Fixture();
	let rpc = new ImageCodexRpc();
	let native: CodexSession;
	const start = () =>
		startPersistentApp({
			engine: createCodexEngine({ services, models }),
			createSession: async (options) => {
				native = await createCodexSession({
					...options,
					services,
					models,
					rpcClient: rpc,
				});
				return native;
			},
			imageEngine: { baseUrl: ima2.baseUrl },
			workspace,
			agentDir,
			stateRoot: join(root, "state"),
			systemPrompt: "Isolated synthetic image QA. No external model calls.",
			memoryBackend: "disabled",
			port: 0,
		});
	let app: Awaited<ReturnType<typeof startPersistentApp>>;
	try {
		app = await start();
	} catch (error) {
		await ima2.stop();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	return {
		root,
		ima2,
		get app() {
			return app;
		},
		get native() {
			return native;
		},
		get rpc() {
			return rpc;
		},
		async restart() {
			await app.stop();
			await rpc.close();
			rpc = new ImageCodexRpc();
			app = await start();
		},
		async submit(text: string): Promise<string> {
			const requestId = randomUUID();
			const previous = new Set(
				app.runtime.snapshot().messages.map((m) => m.entryId),
			);
			const done = Promise.withResolvers<void>();
			const check = (snapshot: SessionSnapshot) => {
				const request = snapshot.requests.find(
					(request) => request.id === requestId,
				);
				if (request?.status === "rejected" || request?.status === "interrupted")
					done.reject(Error(request.error ?? request.status));
				if (
					request?.status === "settled" &&
					snapshot.messages.some(
						(m) => m.entryId.startsWith("notice-") && !previous.has(m.entryId),
					)
				)
					done.resolve();
			};
			const off = app.runtime.subscribe((event) => {
				if (event.type === "snapshot") check(event.snapshot);
			});
			try {
				app.runtime.submit(requestId, text);
				await done.promise;
				// The notice was already observed; join its pending manifest acknowledgement.
				await app.images?.flushNotices();
				return requestId;
			} finally {
				off();
			}
		},
		async close(keepRoot = false) {
			await app.stop();
			await rpc.close();
			await ima2.stop();
			if (!keepRoot) rmSync(root, { recursive: true, force: true });
		},
	};
}
