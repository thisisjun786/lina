import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
	LifeModelRequest,
	LifeModelUsage,
} from "../../lina-core/src/world/autonomy-types.ts";
import { authorRecord } from "./author-native-policy.ts";
import {
	LIFE_UNKNOWN_USAGE,
	LIFE_WIRE_OVERHEAD,
	lifeUsage,
} from "./life-model-validation.ts";

export function inspectLifeCatalog(value: unknown): void {
	if (!Array.isArray(value)) throw Error("Missing LIFE native catalog");
	for (const raw of value) {
		const tool = authorRecord(raw);
		// Native 0.153.4 retains discovery. The separate native inventory must be empty.
		if (
			tool["type"] !== "namespace" ||
			tool["name"] !== "skills" ||
			!Array.isArray(tool["tools"]) ||
			!tool["tools"].every((entry: unknown) => {
				const t = authorRecord(entry);
				return (
					t["type"] === "function" &&
					(t["name"] === "list" || t["name"] === "read")
				);
			})
		)
			throw Error("Forbidden LIFE native tool catalog");
	}
}
function inspectLifeInput(
	body: Record<string, unknown>,
	request: LifeModelRequest,
): void {
	const allowed = [
		"model",
		"instructions",
		"input",
		"tools",
		"tool_choice",
		"parallel_tool_calls",
		"reasoning",
		"store",
		"stream",
		"include",
		"prompt_cache_key",
		"client_metadata",
	];
	if (
		Object.keys(body).some((key) => !allowed.includes(key)) ||
		!Array.isArray(body["input"]) ||
		body["input"].length < 1 ||
		body["input"].length > 3
	)
		throw Error("Unexpected LIFE transport fields");
	const messages = body["input"].map((raw: unknown) => {
		const item = authorRecord(raw);
		if (
			Object.keys(item).some(
				(key) => !["type", "id", "role", "content"].includes(key),
			) ||
			(item["type"] != null && item["type"] !== "message") ||
			!["developer", "user"].includes(String(item["role"])) ||
			!Array.isArray(item["content"]) ||
			item["content"].length !== 1
		)
			throw Error("Forbidden LIFE input item");
		const content = authorRecord(item["content"][0]);
		if (
			Object.keys(content).some((key) => !["type", "text"].includes(key)) ||
			content["type"] !== "input_text" ||
			typeof content["text"] !== "string"
		)
			throw Error("LIFE input must be text only");
		return { role: item["role"], text: content["text"] };
	});
	const last = messages.at(-1);
	if (last?.role !== "user" || last.text !== request.input)
		throw Error("LIFE input differs from its admitted request");
}
async function boundedBody(
	body: ReadableStream<Uint8Array> | null,
	maximum: number,
): Promise<Uint8Array> {
	if (!body) throw Error("Missing LIFE transport body");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > maximum) throw Error("LIFE transport byte bound exceeded");
			chunks.push(next.value);
		}
		return Buffer.concat(chunks);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
function upstreamUsage(bytes: Uint8Array): LifeModelUsage {
	let usage = { ...LIFE_UNKNOWN_USAGE };
	let data: string[] = [];
	// SSE joins all data fields in a complete event, strips at most one space,
	// and accepts LF, CRLF or CR. A partial event at EOF is not dispatched.
	const stream = Buffer.from(bytes)
		.toString("utf8")
		.replace(/^\uFEFF/, "");
	const lines = stream.split(/\r\n|\r|\n/);
	lines.pop();
	for (const line of lines) {
		if (line !== "") {
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":"),
				field = colon < 0 ? line : line.slice(0, colon);
			if (field !== "data") continue;
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			data.push(value);
			continue;
		}
		if (!data.length) continue;
		const payload = data.join("\n");
		data = [];
		if (payload.trim() === "[DONE]") continue;
		const event = authorRecord(JSON.parse(payload));
		if (event["type"] !== "response.completed") continue;
		const raw = authorRecord(event["response"])["usage"];
		if (raw == null) continue;
		const row = authorRecord(raw);
		usage = lifeUsage({
			inputTokens: row["input_tokens"] ?? null,
			outputTokens: row["output_tokens"] ?? null,
			totalTokens: row["total_tokens"] ?? null,
		});
	}
	return usage;
}
export interface LifeModelGatewayOptions {
	baseUrl: string;
	credential: string | undefined;
	request: LifeModelRequest;
	signal: AbortSignal;
	beforeOutbound(): void;
	observed(usage: LifeModelUsage): void;
}

/** The only configured-provider route. The child receives a nonce, never this credential. */
export function createLifeModelGateway(options: LifeModelGatewayOptions) {
	const upstream = new URL(`${options.baseUrl.replace(/\/$/, "")}/responses`);
	if (
		!["http:", "https:"].includes(upstream.protocol) ||
		upstream.username ||
		upstream.password ||
		upstream.search ||
		upstream.hash
	)
		throw Error("Invalid LIFE provider endpoint");
	const nonce = randomBytes(32).toString("hex");
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, options.signal]);
	const active = new Set<Promise<Response>>();
	let upstreamAttempts: 0 | 1 = 0,
		claimed = false,
		deniedPosts = 0;
	let usage = { ...LIFE_UNKNOWN_USAGE };
	let responseReceived = false,
		failure: string | null = null;
	let closing: Promise<void> | undefined;
	const deny = (status: number) =>
		new Response("LIFE transport rejected", { status });
	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (
			request.method !== "POST" ||
			url.pathname !== "/v1/responses" ||
			url.search ||
			url.hash
		)
			return deny(404);
		const auth = Buffer.from(request.headers.get("authorization") ?? "");
		const expected = Buffer.from(`Bearer ${nonce}`);
		if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
			return deny(401);
		if (claimed) {
			deniedPosts++;
			failure = "Native attempted a second Responses POST";
			return deny(409);
		}
		try {
			signal.throwIfAborted();
			const bytes = await boundedBody(
				request.body,
				options.request.limits.maxInputBytes + LIFE_WIRE_OVERHEAD,
			);
			const body = authorRecord(
				JSON.parse(Buffer.from(bytes).toString("utf8")),
			);
			if (
				body["model"] !== options.request.model ||
				body["instructions"] !== options.request.systemPrompt ||
				body["stream"] !== true ||
				!Array.isArray(body["input"])
			)
				throw Error("LIFE model/body mismatch");
			inspectLifeCatalog(body["tools"]);
			inspectLifeInput(body, options.request);
			if (claimed) {
				deniedPosts++;
				failure = "Native attempted a concurrent Responses POST";
				return deny(409);
			}
			// Claim before invoking callbacks. The marker is durable before any external I/O.
			claimed = true;
			signal.throwIfAborted();
			options.beforeOutbound();
			upstreamAttempts = 1;
			const response = await fetch(upstream, {
				method: "POST",
				redirect: "manual",
				signal,
				headers: {
					"content-type": "application/json",
					...(options.credential
						? { authorization: `Bearer ${options.credential}` }
						: {}),
				},
				body: bytes,
			});
			if (
				!response.ok ||
				!response.headers.get("content-type")?.startsWith("text/event-stream")
			) {
				responseReceived = true;
				await response.body?.cancel();
				throw Error("LIFE provider status or response type rejected");
			}
			const result = await boundedBody(
				response.body,
				options.request.limits.maxOutputBytes + LIFE_WIRE_OVERHEAD,
			);
			usage = upstreamUsage(result);
			options.observed(usage);
			responseReceived = true;
			return new Response(result, {
				headers: { "content-type": "text/event-stream" },
			});
		} catch {
			failure ??= "LIFE provider transport failed";
			return deny(upstreamAttempts ? 502 : 400);
		}
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize:
			options.request.limits.maxInputBytes + LIFE_WIRE_OVERHEAD,
		fetch(request) {
			const pending = handle(request);
			active.add(pending);
			void pending.finally(() => active.delete(pending));
			return pending;
		},
	});
	return {
		baseUrl: `${server.url.origin}/v1`,
		nonce,
		get upstreamAttempts() {
			return upstreamAttempts;
		},
		get usage() {
			return { ...usage };
		},
		get deniedPosts() {
			return deniedPosts;
		},
		get responseReceived() {
			return responseReceived;
		},
		get failure() {
			return failure;
		},
		close(): Promise<void> {
			closing ??= (async () => {
				controller.abort();
				await server.stop(true);
				await Promise.allSettled([...active]);
			})();
			return closing;
		},
	};
}
export type LifeModelGateway = ReturnType<typeof createLifeModelGateway>;
