import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import {
	decodeNativeEvent,
	projectNativeEntry,
} from "../../lina-runtime/src/sdk-events.ts";
import {
	commitCodexThread,
	initializeCodexSessionFile,
	inspectCodexSessionFile,
	markCodexThreadPending,
	readCodexSessionHeader,
} from "../src/identity.ts";
import { createCodexSession } from "../src/session.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lina-codex-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function services(): ContextServices {
	return {
		estimateText: (text) => text.length,
		estimateMessages: (messages) => messages.length,
		systemTokens: 0,
		contextWindow: 128000,
		reserveTokens: 1000,
		summarize: async () => {
			throw new Error("summarize unused");
		},
		prepare: () => {
			throw new Error("prepare unused");
		},
	};
}

function models(): ModelControl {
	return {
		catalog: () => [
			{
				provider: "opencodex",
				id: "cursor/gemini-3.8-flash",
				name: "flash",
				contextWindow: 128000,
				maxOutputTokens: 2048,
				reasoning: false,
				authenticated: true,
			},
		],
		state: () => ({
			provider: "opencodex",
			model: "cursor/gemini-3.8-flash",
			settingsRevision: 1,
			error: null,
		}),
		async test() {
			return {
				provider: "opencodex",
				model: "cursor/gemini-3.8-flash",
				text: "ok",
				durationMs: 1,
				inputTokens: 1,
				outputTokens: 1,
			};
		},
	};
}

function fakeStdio() {
	const input = new PassThrough();
	const output = new PassThrough();
	let buffer = "";
	const lines: unknown[] = [];
	const waiters: Array<(value: unknown) => void> = [];
	input.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString("utf8");
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim()) {
				const parsed: unknown = JSON.parse(line);
				const waiter = waiters.shift();
				if (waiter) waiter(parsed);
				else lines.push(parsed);
			}
			idx = buffer.indexOf("\n");
		}
	});
	return {
		input,
		output,
		reply(value: unknown) {
			output.write(`${JSON.stringify(value)}\n`);
		},
		async next(): Promise<Record<string, unknown>> {
			const queued = lines.shift();
			if (queued !== undefined) return queued as Record<string, unknown>;
			return await new Promise((resolve) => {
				waiters.push((value) => resolve(value as Record<string, unknown>));
			});
		},
	};
}

type ThreadState = {
	id: string;
	path: string;
	tools: unknown;
	turns: unknown[];
};

function scriptedServer(
	io: ReturnType<typeof fakeStdio>,
	thread: ThreadState,
	rejectInstructions = false,
) {
	void (async () => {
		for (;;) {
			const msg = await io.next();
			const method = msg["method"];
			const id = msg["id"];
			if (id === undefined) continue;
			const params = (msg["params"] ?? {}) as Record<string, unknown>;
			if (method === "model/list") {
				io.reply({
					id,
					result: {
						data: [
							{
								id: "cursor/gemini-3.8-flash",
								model: "cursor/gemini-3.8-flash",
							},
						],
					},
				});
				continue;
			}
			if (method === "initialize") {
				io.reply({
					id,
					result: {
						userAgent: "lina-test",
						codexHome: "/tmp/lina-codex-fake",
						platformFamily: "unix",
						platformOs: "linux",
					},
				});
				continue;
			}
			if (method === "skills/extraRoots/set") {
				io.reply({ id, result: {} });
				continue;
			}
			if (method === "skills/list") {
				io.reply({
					id,
					result: {
						data: [
							{
								cwd: params["cwds"],
								skills: [
									{
										name: "paperthin-test",
										description: "test",
										path: "/tmp/skill",
										scope: "repo",
										enabled: true,
										pluginId: null,
									},
								],
								errors: [],
							},
						],
					},
				});
				continue;
			}
			if (method === "thread/start") {
				thread.tools = params["dynamicTools"];
				io.reply({
					id,
					result: {
						thread: {
							id: thread.id,
							path: thread.path,
							turns: [],
							status: { type: "idle" },
							historyMode: "legacy",
							cwd: params["cwd"],
							model: params["model"],
							modelProvider: params["modelProvider"],
						},
						model: params["model"],
						modelProvider: params["modelProvider"],
						cwd: params["cwd"],
						approvalPolicy: "never",
						sandbox: { type: "readOnly" },
					},
				});
				continue;
			}
			if (method === "thread/inject_items") {
				io.reply(
					rejectInstructions
						? {
								id,
								error: {
									code: -32601,
									message: "instruction injection unavailable",
								},
							}
						: { id, result: {} },
				);
				continue;
			}
			if (method === "thread/name/set") {
				writeFileSync(thread.path, "{}\n");
				io.reply({ id, result: {} });
				continue;
			}
			if (method === "thread/resume") {
				if (params["threadId"] !== thread.id) {
					io.reply({
						id,
						error: {
							code: -32600,
							message: `no rollout found for thread id ${String(params["threadId"])}`,
						},
					});
					continue;
				}
				io.reply({
					id,
					result: {
						thread: {
							id: thread.id,
							path: thread.path,
							turns: thread.turns,
							status: { type: "idle" },
						},
					},
				});
				continue;
			}
			if (method === "thread/read" || method === "thread/items/list") {
				io.reply({
					id,
					result:
						method === "thread/read"
							? {
									thread: {
										id: thread.id,
										turns: thread.turns,
										status: { type: "idle" },
									},
								}
							: { data: [], nextCursor: null },
				});
				continue;
			}
			if (method === "turn/start") {
				const turnId = "turn-1";
				const text = String(
					(params["input"] as Array<{ text?: string }>)[0]?.text ?? "",
				);
				io.reply({
					id,
					result: { turn: { id: turnId, items: [], status: "inProgress" } },
				});
				io.reply({
					method: "turn/started",
					params: {
						threadId: thread.id,
						turn: { id: turnId, items: [], status: "inProgress" },
					},
				});
				io.reply({
					method: "item/completed",
					params: {
						item: {
							type: "userMessage",
							id: "user-1",
							clientId: null,
							content: [{ type: "text", text, text_elements: [] }],
						},
						threadId: thread.id,
						turnId,
						completedAtMs: Date.now(),
					},
				});
				if (text.includes("probe") && thread.tools) {
					io.reply({
						method: "item/tool/call",
						id: 0,
						params: {
							threadId: thread.id,
							turnId,
							callId: "call-1",
							namespace: null,
							tool: "lina_status",
							arguments: {},
						},
					});
				}
				io.reply({
					method: "item/agentMessage/delta",
					params: {
						threadId: thread.id,
						turnId,
						itemId: "asst-1",
						delta: "hello",
					},
				});
				io.reply({
					method: "item/completed",
					params: {
						item: {
							type: "agentMessage",
							id: "asst-1",
							text: "hello",
							phase: "final_answer",
						},
						threadId: thread.id,
						turnId,
						completedAtMs: Date.now(),
					},
				});
				io.reply({
					method: "thread/tokenUsage/updated",
					params: {
						threadId: thread.id,
						turnId,
						tokenUsage: {
							total: { totalTokens: 12, inputTokens: 8, outputTokens: 4 },
							last: { totalTokens: 12, inputTokens: 8, outputTokens: 4 },
							modelContextWindow: 128000,
						},
					},
				});
				io.reply({
					method: "turn/completed",
					params: {
						threadId: thread.id,
						turn: { id: turnId, items: [], status: "completed" },
					},
				});
				continue;
			}
			if (method === "turn/interrupt") {
				io.reply({ id, result: {} });
				io.reply({
					method: "turn/completed",
					params: {
						threadId: thread.id,
						turn: { id: params["turnId"], items: [], status: "interrupted" },
					},
				});
				continue;
			}
			if (method === "thread/compact/start") {
				io.reply({ id, result: {} });
				io.reply({
					method: "thread/compacted",
					params: { threadId: thread.id, turnId: "compact-1" },
				});
				continue;
			}
			io.reply({
				id,
				error: { code: -32601, message: `unknown ${String(method)}` },
			});
		}
	})();
}

test("initialize writes a Lina-owned Codex header and inspect rejects the wrong workspace", () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	inspectCodexSessionFile(file, dir);
	const identity = initializeCodexSessionFile(file, dir);
	expect(identity.sessionId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "");
	expect(header).toMatchObject({
		type: "session",
		engine: "codex",
		version: 1,
		id: identity.sessionId,
		cwd: dir,
	});
	expect(initializeCodexSessionFile(file, dir).sessionId).toBe(
		identity.sessionId,
	);
	expect(() => inspectCodexSessionFile(file, tempDir())).toThrow(/workspace/i);
});

test("pending thread create without a native id fails closed", () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	markCodexThreadPending(file, dir);
	expect(readCodexSessionHeader(file, dir).threadCreate).toBe("pending");
	expect(() => initializeCodexSessionFile(file, dir)).toThrow(
		/second thread|ambiguous/i,
	);
	commitCodexThread(file, dir, "01thread");
	expect(readCodexSessionHeader(file, dir).nativeThreadId).toBe("01thread");
});

test("session registers tools before thread/start, persists id, and projects DurableRuntime events", async () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const io = fakeStdio();
	const thread: ThreadState = {
		id: "01native-thread",
		path: join(dir, "rollout.jsonl"),
		tools: null,
		turns: [],
	};
	scriptedServer(io, thread);
	const order: string[] = [];
	const events: unknown[] = [];
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "You are Lina.",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3_000,
		},
		skillRoots: ["/tmp/paperthin-skills"],
		register(host) {
			order.push("register");
			host.on("before_agent_start", async (event, context) => {
				order.push("before_agent_start");
				expect(event.prompt).toBe("hi");
				expect(context.signal).toBeInstanceOf(AbortSignal);
			});
			host.on("context", () => {
				order.push("context");
				return {
					messages: [
						{
							role: "custom",
							customType: "lina-context-reference",
							display: false,
							content: "memory",
							timestamp: 0,
						},
					],
				};
			});
			host.registerTool({
				name: "lina_status",
				label: "status",
				description: "status",
				parameters: { type: "object", properties: {} },
				async execute() {
					order.push("tool");
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			});
		},
	});
	cleanup.push(() => session.close());
	expect(order[0]).toBe("register");
	expect(thread.tools).toEqual([
		expect.objectContaining({ type: "function", name: "lina_status" }),
	]);
	expect(readCodexSessionHeader(file, dir).nativeThreadId).toBe(
		"01native-thread",
	);
	expect(session.sessionId).not.toBe("01native-thread");
	expect(session.threadId).toBe("01native-thread");
	const unsub = session.subscribe((event) => events.push(event));
	let admitted = "";
	await session.prompt("hi", {
		signal: new AbortController().signal,
		disposition: (value) => {
			admitted = value;
		},
		rejected: () => {
			admitted = "rejected";
		},
	});
	expect(admitted).toBe("started");
	expect(order).toEqual(["register", "before_agent_start", "context"]);
	unsub();
	const projected = events.flatMap((raw) => {
		const decoded = decodeNativeEvent(raw);
		return decoded ? [decoded] : [];
	});
	expect(projected.some((event) => event.type === "start")).toBe(true);
	expect(projected.some((event) => event.type === "text")).toBe(true);
	expect(projected.some((event) => event.type === "settled")).toBe(true);
	const user = session
		.history()
		.map(projectNativeEntry)
		.find((entry) => entry?.role === "user");
	expect(user?.entryId).toBe("codex:turn-1:user:0");
	expect(user?.text).toBe("hi");
	expect(session.usage()).toEqual({ tokens: 12, contextWindow: 128000 });
});

test("complete current persona travels as developer instructions, never truncated additional context", async () => {
	const dir = tempDir(),
		file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const io = fakeStdio();
	const seen: Record<string, unknown>[] = [];
	const injected: Record<string, unknown>[] = [];
	const order: string[] = [];
	const original = io.next.bind(io);
	io.next = async () => {
		const msg = await original();
		if (msg["method"] === "thread/inject_items") {
			injected.push(msg["params"] as Record<string, unknown>);
			order.push("instructions");
		}
		if (msg["method"] === "turn/start") {
			seen.push(msg["params"] as Record<string, unknown>);
			order.push("turn");
		}
		return msg;
	};
	scriptedServer(io, {
		id: "persona-native",
		path: join(dir, "rollout.jsonl"),
		tools: null,
		turns: [],
	});
	let persona =
		"Shared policy. ".repeat(2500) +
		"\nName: 세라\nFull confirmed character and user context.";
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "Shared policy.",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3000,
		},
		register(host) {
			host.on("before_agent_start", () => ({ systemPrompt: persona }));
		},
	});
	cleanup.push(() => session.close());
	await session.prompt("hi", {
		signal: new AbortController().signal,
		disposition() {},
		rejected() {
			throw Error("unexpected rejection");
		},
	});
	expect(seen).toHaveLength(1);
	expect(order).toEqual(["instructions", "turn"]);
	expect(injected).toHaveLength(1);
	const item = (
		injected[0]?.["items"] as Array<{
			role: string;
			content: Array<{ text: string }>;
		}>
	)?.[0];
	expect(item?.role).toBe("developer");
	expect(item?.content[0]?.text.endsWith(persona)).toBe(true);
	expect(item?.content[0]?.text).toContain(
		"replaces earlier Lina instruction snapshots",
	);
	expect(seen[0]?.["collaborationMode"]).toBeUndefined();
	expect(seen[0]?.["input"]).toEqual([
		{ type: "text", text: "hi", text_elements: [] },
	]);
	expect(
		(seen[0]?.["additionalContext"] as Record<string, unknown> | undefined)?.[
			"lina-system-prompt"
		],
	).toBeUndefined();
	const admission = {
		signal: new AbortController().signal,
		disposition() {},
		rejected() {
			throw Error("rejected");
		},
	};
	await session.prompt("unchanged", admission);
	expect(injected).toHaveLength(1);
	persona =
		"Current persona: 다온. No first-reply guidance; user context is no longer shared.";
	await session.prompt("updated", admission);
	expect(injected).toHaveLength(2);
	const updated = (
		injected[1]?.["items"] as Array<{ content: Array<{ text: string }> }>
	)?.[0]?.content[0]?.text;
	expect(updated?.endsWith(persona)).toBe(true);
	expect(updated).not.toContain("세라");
	expect(order).toEqual([
		"instructions",
		"turn",
		"turn",
		"instructions",
		"turn",
	]);
	await session.compact();
	await session.prompt("after compaction", admission);
	expect(injected).toHaveLength(3);
});

test("failed instruction delivery rejects the request before starting a user turn", async () => {
	const dir = tempDir(),
		file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const io = fakeStdio();
	const methods: unknown[] = [];
	const next = io.next.bind(io);
	io.next = async () => {
		const m = await next();
		methods.push(m["method"]);
		return m;
	};
	scriptedServer(
		io,
		{
			id: "delivery-failure",
			path: join(dir, "rollout.jsonl"),
			tools: null,
			turns: [],
		},
		true,
	);
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "base",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3000,
		},
		register(host) {
			host.on("before_agent_start", () => ({
				systemPrompt: "confirmed persona",
			}));
		},
	});
	cleanup.push(() => session.close());
	let rejected = false;
	await expect(
		session.prompt("hello", {
			signal: new AbortController().signal,
			disposition() {
				throw Error("unexpected start");
			},
			rejected() {
				rejected = true;
			},
		}),
	).rejects.toThrow("instruction injection unavailable");
	expect(rejected).toBe(true);
	expect(methods).not.toContain("turn/start");
});

test("resume uses the exact native id and does not fork", async () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	commitCodexThread(file, dir, "exact-id");
	const io = fakeStdio();
	const thread: ThreadState = {
		id: "exact-id",
		path: join(dir, "rollout.jsonl"),
		tools: [{ type: "function", name: "lina_status" }],
		turns: [],
	};
	scriptedServer(io, thread);
	const seen: string[] = [];
	const originalNext = io.next.bind(io);
	io.next = async () => {
		const msg = await originalNext();
		if (typeof msg["method"] === "string") seen.push(msg["method"]);
		return msg;
	};
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "Lina",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3_000,
		},
	});
	cleanup.push(() => session.close());
	expect(seen).toContain("thread/resume");
	expect(seen).not.toContain("thread/start");
	expect(seen).not.toContain("thread/fork");
	expect(session.threadId).toBe("exact-id");
});

test("compact waits for native completion", async () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const io = fakeStdio();
	scriptedServer(io, {
		id: "native",
		path: join(dir, "rollout.jsonl"),
		tools: [],
		turns: [],
	});
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "Lina",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3_000,
		},
	});
	cleanup.push(() => session.close());
	await expect(session.compact()).resolves.toMatchObject({
		threadId: "native",
	});
});

test("appendNotice persists and dedupes in the identity journal", async () => {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const io = fakeStdio();
	scriptedServer(io, {
		id: "native",
		path: join(dir, "rollout.jsonl"),
		tools: [],
		turns: [],
	});
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "Lina",
		services: services(),
		models: models(),
		rpc: {
			stdio: { input: io.input, output: io.output },
			ownsProcess: false,
			timeoutMs: 3_000,
		},
	});
	cleanup.push(() => session.close());
	const marker = { jobId: "job-1", terminalRevision: 1 };
	const first = await session.appendNotice(marker, "done");
	const second = await session.appendNotice(marker, "done again");
	expect(first).toBeTruthy();
	expect(second).toBe(first);
	const journal = readFileSync(file, "utf8");
	expect(journal).toContain("lina.development");
	expect(journal.split("lina.development").length - 1).toBe(1);
});
