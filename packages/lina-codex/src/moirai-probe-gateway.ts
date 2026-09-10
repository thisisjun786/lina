import { randomBytes } from "node:crypto";
import { authorRecord } from "./author-native-policy.ts";
import { inspectLifeCatalog } from "./life-model-gateway.ts";
import {
	PROBE_REQUEST_OPTIONS,
	type ProbeCapture,
	probeProviderText,
	probeWireItems,
	verifyProbeUsage,
	verifyProbeWire,
} from "./moirai-probe-transport.ts";

type ClaimInput = {
	key: string;
	episodeId: string;
	input: string;
	instructions: string;
	previous: ProbeCapture | null;
};
type Claim = ClaimInput & {
	claimed: boolean;
	done: ReturnType<typeof Promise.withResolvers<ProbeCapture>>;
};
type Options = {
	baseUrl: string;
	credential?: string;
	model: string;
	/** Exact provider response name when it differs from the routed request ID. */
	responseModel?: string;
	record: (key: string, value: unknown) => void;
	fetchImpl?: typeof fetch;
};
const MAX_BYTES = 1048576;
function completedCapture(raw: string, responseModel?: string) {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
	if (!text.endsWith("\n\n")) throw Error("Truncated SSE");
	let completed = 0;
	let usage: unknown = null;
	let output: unknown[] = [];
	for (const frame of text.split("\n\n")) {
		const data = frame
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		const event = authorRecord(JSON.parse(data));
		if (
			event["type"] === "error" ||
			event["type"] === "response.failed" ||
			event["type"] === "response.incomplete"
		)
			throw Error("Failed provider event");
		if (event["type"] !== "response.completed") continue;
		const response = authorRecord(event["response"]);
		if (responseModel !== undefined && response["model"] !== responseModel)
			throw Error("Provider response model mismatch");
		if (
			response["status"] !== "completed" ||
			!Array.isArray(response["output"]) ||
			response["output"].some(
				(i) =>
					!["message", "reasoning"].includes(String(authorRecord(i)["type"])),
			)
		)
			throw Error("Invalid terminal response");
		output = probeWireItems(response["output"]);
		probeProviderText(output);
		usage = response["usage"] ?? null;
		verifyProbeUsage(usage);
		completed++;
	}
	if (completed !== 1) throw Error("Missing or duplicate completion");
	return { usage, output, text: probeProviderText(output) };
}
/** QA-owned admission proxy. The production LIFE gateway remains unchanged. */
export function createMoiraiProbeGateway(options: Options) {
	const upstream = new URL(`${options.baseUrl.replace(/\/$/, "")}/responses`);
	if (
		!["http:", "https:"].includes(upstream.protocol) ||
		upstream.username ||
		upstream.password ||
		upstream.search ||
		upstream.hash
	)
		throw Error("Invalid upstream");
	const nonce = randomBytes(32).toString("hex");
	const claims = new Map<string, Claim>();
	const counts = new Map<string, number>();
	const controllers = new Set<AbortController>();
	const streams = new Set<Promise<void>>();
	let closed = false;
	const record = (key: string, value: unknown) => options.record(key, value);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: MAX_BYTES,
		async fetch(req) {
			if (closed) return new Response("closed", { status: 503 });
			if (
				req.method !== "POST" ||
				new URL(req.url).pathname !== "/v1/responses" ||
				req.headers.get("authorization") !== `Bearer ${nonce}`
			)
				return new Response("denied", { status: 403 });
			let claim: Claim | undefined;
			try {
				const bytes = await req.arrayBuffer();
				if (bytes.byteLength > MAX_BYTES) throw Error("Input byte limit");
				const body = authorRecord(
					JSON.parse(Buffer.from(bytes).toString("utf8")),
				);
				if (body["model"] !== options.model || body["stream"] !== true)
					throw Error("Model or stream mismatch");
				if (
					Object.keys(body).some(
						(key) =>
							![
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
								"max_output_tokens",
							].includes(key),
					)
				)
					throw Error("Unexpected probe transport fields");
				const items = probeWireItems(body["input"]);
				const last = items.at(-1);
				const input =
					last?.["role"] === "user"
						? (last["content"] as Array<{ text: string }>)
								.map((p) => p.text)
								.join("")
						: null;
				claim = [...claims.values()].find(
					(c) => c.input === input && c.instructions === body["instructions"],
				);
				if (!claim) return new Response("unregistered", { status: 403 });
				if (claim.claimed) return new Response("duplicate", { status: 409 });
				record(`${claim.key}-received`, { body });
				verifyProbeWire(items, claim.input, claim.previous);
				inspectLifeCatalog(body["tools"]);
				const consumed = counts.get(claim.episodeId) ?? 0;
				if (consumed >= 6) {
					claim.claimed = true;
					record(`${claim.key}-failure`, {
						reason: "episode_limit",
						attempts: consumed,
					});
					claim.done.reject(Error("Episode attempt limit"));
					return new Response("episode limit", { status: 429 });
				}
				claim.claimed = true;
				counts.set(claim.episodeId, consumed + 1);
				const wire = {
					...body,
					...PROBE_REQUEST_OPTIONS,
					max_output_tokens: 4096,
					tools: [],
					tool_choice: "none",
				};
				record(`${claim.key}-outbound`, {
					episodeId: claim.episodeId,
					attempt: consumed + 1,
					startedAt: Date.now(),
					nativeBody: body,
					body: wire,
				});
				const controller = new AbortController();
				controllers.add(controller);
				const signal = AbortSignal.any([
					controller.signal,
					req.signal,
					AbortSignal.timeout(120000),
				]);
				let response: Response;
				try {
					response = await (options.fetchImpl ?? fetch)(upstream, {
						method: "POST",
						redirect: "manual",
						signal,
						headers: {
							"content-type": "application/json",
							...(options.credential
								? { authorization: `Bearer ${options.credential}` }
								: {}),
						},
						body: JSON.stringify(wire),
					});
					if (
						!response.ok ||
						!response.headers
							.get("content-type")
							?.startsWith("text/event-stream") ||
						!response.body
					) {
						await response.body?.cancel();
						throw Error(`Provider status ${response.status}`);
					}
				} catch (error) {
					controllers.delete(controller);
					throw error;
				}
				const current = claim;
				const reader = response.body.getReader();
				const cancelReader = () => {
					void reader.cancel().catch(() => {});
				};
				signal.addEventListener("abort", cancelReader, { once: true });
				if (signal.aborted) cancelReader();
				const task = Promise.withResolvers<void>();
				streams.add(task.promise);
				const stream = new ReadableStream<Uint8Array>({
					start(destination) {
						void (async () => {
							const chunks: Uint8Array[] = [];
							let size = 0;
							try {
								for (;;) {
									signal.throwIfAborted();
									const next = await reader.read();
									if (next.done) break;
									size += next.value.byteLength;
									if (size > MAX_BYTES) throw Error("Output byte limit");
									chunks.push(next.value);
									destination.enqueue(next.value);
								}
								const raw = Buffer.concat(chunks).toString("utf8");
								// Capture even malformed/truncated provider output before interpreting it.
								record(`${current.key}-response`, {
									endedAt: Date.now(),
									raw,
									attempts: counts.get(current.episodeId),
								});
								const capture = {
									...completedCapture(raw, options.responseModel),
									input: items,
								};
								record(`${current.key}-settled`, {
									...capture,
									endedAt: Date.now(),
								});
								current.done.resolve(capture);
								destination.close();
							} catch (error) {
								const reason =
									error instanceof Error ? error.message : "Stream failed";
								try {
									record(`${current.key}-failure`, {
										reason,
										partial: Buffer.concat(chunks).toString("utf8"),
										attempts: counts.get(current.episodeId),
									});
								} catch {}
								current.done.reject(Error(reason));
								try {
									destination.error(Error(reason));
								} catch {}
							} finally {
								await reader.cancel().catch(() => {});
								reader.releaseLock();
								signal.removeEventListener("abort", cancelReader);
								controllers.delete(controller);
								streams.delete(task.promise);
								task.resolve();
							}
						})();
					},
					cancel() {
						controller.abort(Error("Native cancelled stream"));
					},
				});
				return new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				});
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : "Gateway failure";
				if (claim) {
					try {
						record(`${claim.key}-failure`, {
							reason,
							attempts: counts.get(claim.episodeId) ?? 0,
						});
					} catch {}
					claim.done.reject(Error(reason));
				}
				return new Response("gateway rejected", { status: 400 });
			}
		},
	});
	return {
		baseUrl: `${server.url.origin}/v1`,
		nonce,
		expect(input: ClaimInput) {
			if (
				closed ||
				input.previous === undefined ||
				!/^[a-zA-Z0-9-]+$/.test(input.key) ||
				!input.episodeId ||
				claims.has(input.key) ||
				[...claims.values()].some(
					(c) =>
						c.input === input.input && c.instructions === input.instructions,
				)
			)
				throw Error("Duplicate or invalid claim");
			const done = Promise.withResolvers<ProbeCapture>();
			void done.promise.catch(() => {});
			claims.set(input.key, {
				...structuredClone(input),
				claimed: false,
				done,
			});
		},
		settled(key: string) {
			const c = claims.get(key);
			if (!c) throw Error("Unknown claim");
			return c.done.promise;
		},
		async close() {
			closed = true;
			for (const c of claims.values()) c.done.reject(Error("Gateway closed"));
			for (const c of controllers) c.abort(Error("Gateway closed"));
			await server.stop(true);
			await Promise.allSettled([...streams]);
		},
	};
}
