import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import type { PromptAdmission } from "../../lina-runtime/src/sdk-port.ts";
import { CodexHost, jsonSchemaOf, validateToolArguments } from "../src/host.ts";
import { initializeCodexSessionFile } from "../src/identity.ts";
import { conversationTurn } from "../src/model.ts";
import type { CodexRpc, CodexRpcRequestHandler } from "../src/rpc.ts";
import { createCodexSession } from "../src/session.ts";

const MODEL = "cursor/gemini-3.8-flash";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lina-codex-life-"));
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

function models(provider = "opencodex"): ModelControl {
	return {
		catalog: () => [
			{
				provider,
				id: MODEL,
				name: "flash",
				contextWindow: 128000,
				maxOutputTokens: 2048,
				reasoning: false,
				authenticated: true,
			},
		],
		state: () => ({
			provider,
			model: MODEL,
			settingsRevision: 1,
			error: null,
		}),
		async test() {
			return {
				provider,
				model: MODEL,
				text: "ok",
				durationMs: 1,
				inputTokens: 1,
				outputTokens: 1,
			};
		},
	};
}

function settings(
	reasoning: ModelSettings["profiles"][number]["reasoning"],
): () => ModelSettings {
	return () => ({
		revision: 1,
		profiles: [
			{
				id: "main",
				provider: "opencodex",
				model: MODEL,
				reasoning,
			},
		],
		defaultProfileId: "main",
		roles: {},
		agentRoles: {},
	});
}

function admission(signal = new AbortController().signal): PromptAdmission {
	return {
		signal,
		disposition: () => undefined,
		rejected: () => undefined,
	};
}

type PendingRequest = {
	method: string;
	params: unknown;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

class FakeCodexRpc implements CodexRpc {
	closed = false;
	closeCount = 0;
	subscriberCount = 0;
	requestHandlerCount = 0;
	readonly methods: string[] = [];
	catalog: { data: Array<{ id: string; model: string }> } = {
		data: [{ id: MODEL, model: MODEL }],
	};
	thread = {
		id: "thread-1",
		path: "/tmp/rollout.jsonl",
		turns: [] as unknown[],
		modelProvider: "opencodex",
	};
	private readonly listeners = new Set<
		(method: string, params: unknown) => void
	>();
	private readonly requestHandlers = new Set<CodexRpcRequestHandler>();
	private readonly queued = new Map<string, PendingRequest[]>();
	private readonly waiting = new Map<
		string,
		Array<(pending: PendingRequest) => void>
	>();
	private readonly auto = new Set([
		"initialize",
		"model/list",
		"skills/extraRoots/set",
		"skills/list",
		"thread/start",
		"thread/name/set",
		"thread/resume",
		"thread/read",
	]);

	get pid(): number | undefined {
		return undefined;
	}

	emit(method: string, params: unknown = {}): void {
		for (const listener of this.listeners) listener(method, params);
	}

	waitRequest(method: string): Promise<PendingRequest> {
		const queued = this.queued.get(method);
		const pending = queued?.shift();
		if (pending) return Promise.resolve(pending);
		return new Promise((resolve) => {
			const waiters = this.waiting.get(method) ?? [];
			waiters.push(resolve);
			this.waiting.set(method, waiters);
		});
	}

	async request<T>(method: string, params?: unknown): Promise<T> {
		this.methods.push(method);
		if (this.closed) throw new Error("Codex RPC is closed");
		if (this.auto.has(method)) return this.autoReply(method, params) as T;
		return await new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				params,
				resolve: (value) => resolve(value as T),
				reject,
			};
			const waiter = this.waiting.get(method)?.shift();
			if (waiter) waiter(pending);
			else {
				const queued = this.queued.get(method) ?? [];
				queued.push(pending);
				this.queued.set(method, queued);
			}
		});
	}

	notify(): void {
		undefined;
	}

	subscribe(listener: (method: string, params: unknown) => void): () => void {
		this.listeners.add(listener);
		this.subscriberCount += 1;
		return () => {
			if (this.listeners.delete(listener)) this.subscriberCount -= 1;
		};
	}

	onRequest(handler: CodexRpcRequestHandler): () => void {
		this.requestHandlers.add(handler);
		this.requestHandlerCount += 1;
		return () => {
			if (this.requestHandlers.delete(handler)) this.requestHandlerCount -= 1;
		};
	}

	async close(): Promise<void> {
		this.closeCount += 1;
		this.closed = true;
	}

	private autoReply(method: string, _params: unknown): unknown {
		if (method === "model/list") return this.catalog;
		if (method === "skills/list") {
			return {
				data: [
					{
						cwd: "/",
						skills: [{ name: "paperthin-test", enabled: true }],
					},
				],
			};
		}
		if (method === "thread/start" || method === "thread/resume") {
			return { thread: this.thread };
		}
		if (method === "thread/read") {
			return {
				thread: {
					id: this.thread.id,
					turns: this.thread.turns,
					status: { type: "idle" },
					modelProvider: this.thread.modelProvider,
				},
			};
		}
		return method === "initialize" ? { userAgent: "test" } : {};
	}
}

async function openSession(
	fake: FakeCodexRpc,
	options: {
		models?: ModelControl;
		register?: Parameters<typeof createCodexSession>[0]["register"];
	} = {},
) {
	const dir = tempDir();
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "");
	initializeCodexSessionFile(file, dir);
	const session = await createCodexSession({
		workspace: dir,
		sessionFile: file,
		agentDir: dir,
		systemPrompt: "Lina",
		services: services(),
		models: options.models ?? models(),
		rpcClient: fake,
		...(options.register ? { register: options.register } : {}),
	});
	cleanup.push(() => session.close());
	return session;
}

function turnStarted(threadId: string, turnId: string) {
	return {
		threadId,
		turn: { id: turnId, items: [], status: "inProgress" },
	};
}

function completeTurn(
	fake: FakeCodexRpc,
	turnId: string,
	text: string,
	usage?: { total: number; last: number },
): void {
	fake.emit("turn/started", turnStarted(fake.thread.id, turnId));
	fake.emit("item/completed", {
		threadId: fake.thread.id,
		turnId,
		completedAtMs: Date.now(),
		item: {
			type: "userMessage",
			id: `user-${turnId}`,
			content: [{ type: "text", text, text_elements: [] }],
		},
	});
	fake.emit("item/completed", {
		threadId: fake.thread.id,
		turnId,
		completedAtMs: Date.now(),
		item: {
			type: "agentMessage",
			id: `asst-${turnId}`,
			text: "hello",
			phase: "final_answer",
		},
	});
	fake.emit("thread/tokenUsage/updated", {
		threadId: fake.thread.id,
		turnId,
		tokenUsage: {
			total: {
				totalTokens: usage?.total ?? 99,
				inputTokens: 8,
				outputTokens: 4,
			},
			last: {
				totalTokens: usage?.last ?? 12,
				inputTokens: 4,
				outputTokens: 2,
			},
			modelContextWindow: 128000,
		},
	});
	fake.emit("turn/completed", {
		threadId: fake.thread.id,
		turn: { id: turnId, items: [], status: "completed" },
	});
}

test("validateToolArguments rejects type and bound errors via TypeBox", () => {
	const schema = jsonSchemaOf({
		type: "object",
		properties: { n: { type: "number", minimum: 2, maximum: 5 } },
		required: ["n"],
		additionalProperties: false,
	});
	expect(validateToolArguments(schema, { n: 3 })).toEqual({ n: 3 });
	expect(() => validateToolArguments(schema, { n: "3" })).toThrow(/invalid/i);
	expect(() => validateToolArguments(schema, { n: 1 })).toThrow(/invalid/i);
	expect(() => validateToolArguments(schema, { n: 3, extra: true })).toThrow(
		/invalid/i,
	);
	expect(() => validateToolArguments(schema, {})).toThrow(/invalid/i);
	expect(() => validateToolArguments(schema, "nope")).toThrow(/object/i);
});

test("authorizeNative declines without a tool_call handler and honors an explicit decision", async () => {
	const signal = new AbortController().signal;
	const denied = new CodexHost("/tmp", () => ({ action: "ask" }));
	expect(
		await denied.authorizeNative("bash", "c1", { command: "ls" }, signal),
	).toBe(false);

	const allowed = new CodexHost("/tmp", () => ({ action: "ask" }));
	allowed.on("tool_call", () => undefined);
	expect(
		await allowed.authorizeNative("edit", "c2", { reason: "patch" }, signal),
	).toBe(true);

	const blocked = new CodexHost("/tmp", () => ({ action: "ask" }));
	blocked.on("tool_call", () => ({ block: true, reason: "no" }));
	expect(
		await blocked.authorizeNative("bash", "c3", { command: "rm" }, signal),
	).toBe(false);
});

test("conversationTurn rejects a modelProvider change because turn/start cannot switch provider", () => {
	const catalog = { data: [{ id: MODEL, model: MODEL }] };
	expect(
		conversationTurn({ models: models("opencodex") }, catalog, "opencodex")
			.modelProvider,
	).toBe("opencodex");
	expect(() =>
		conversationTurn({ models: models("other") }, catalog, "opencodex"),
	).toThrow(/provider/i);
});

test("conversationTurn maps off to the catalog default effort and omits it for non-reasoning models", () => {
	const withDefault = {
		data: [
			{
				id: MODEL,
				model: MODEL,
				defaultReasoningEffort: "medium",
				supportedReasoningEfforts: [
					{ reasoningEffort: "low" },
					{ reasoningEffort: "medium" },
					{ reasoningEffort: "high" },
				],
			},
		],
	};
	const highOnly = {
		data: [
			{
				id: MODEL,
				model: MODEL,
				supportedReasoningEfforts: [
					{ reasoningEffort: "low" },
					{ reasoningEffort: "high" },
				],
			},
		],
	};
	expect(
		conversationTurn(
			{ models: models(), modelSettings: settings("off") },
			{ data: [{ id: MODEL, model: MODEL }] },
		),
	).toEqual({ model: MODEL, modelProvider: "opencodex" });
	expect(
		conversationTurn(
			{ models: models(), modelSettings: settings("off") },
			withDefault,
		),
	).toEqual({ model: MODEL, modelProvider: "opencodex", effort: "medium" });
	expect(
		conversationTurn(
			{ models: models(), modelSettings: settings("off") },
			highOnly,
		),
	).toEqual({ model: MODEL, modelProvider: "opencodex", effort: "low" });
	expect(
		conversationTurn(
			{ models: models(), modelSettings: settings("high") },
			highOnly,
		),
	).toEqual({ model: MODEL, modelProvider: "opencodex", effort: "high" });
	expect(() =>
		conversationTurn(
			{ models: models(), modelSettings: settings("medium") },
			highOnly,
		),
	).toThrow(/not supported/i);
});

test("EOF rejects waiters immediately, clears the run, and emits continuation_error plus agent_settled", async () => {
	const fake = new FakeCodexRpc();
	const hostSettled = Promise.withResolvers<void>();
	const session = await openSession(fake, {
		register(host) {
			host.on("agent_settled", () => hostSettled.resolve());
		},
	});
	const events: unknown[] = [];
	session.subscribe((event) => events.push(event));
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	start.resolve({
		turn: { id: "turn-eof", items: [], status: "inProgress" },
	});
	fake.emit("turn/started", turnStarted(fake.thread.id, "turn-eof"));
	await Promise.resolve();
	expect(session.hasActiveRun()).toBe(true);
	fake.emit("eof", { message: "Codex RPC ended (EOF)" });
	await expect(prompt).rejects.toThrow(/EOF|ended/i);
	expect(session.hasActiveRun()).toBe(false);
	expect(events).toContainEqual(
		expect.objectContaining({ type: "continuation_error" }),
	);
	expect(events).toContainEqual({ type: "agent_settled" });
	await hostSettled.promise;
});

test("a late turn/start ack after EOF cannot resurrect the run", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	fake.emit("eof", { message: "Codex RPC ended (EOF)" });
	start.resolve({
		turn: { id: "turn-late", items: [], status: "inProgress" },
	});
	await expect(prompt).rejects.toThrow(/EOF|ended/i);
	expect(session.hasActiveRun()).toBe(false);
	await session.close();
	expect(session.hasActiveRun()).toBe(false);
});

test("a late turn/start ack after completion cannot resurrect the run", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	completeTurn(fake, "turn-late", "hi");
	start.resolve({
		turn: { id: "turn-late", items: [], status: "inProgress" },
	});
	await prompt;
	expect(session.hasActiveRun()).toBe(false);
});

test("a rejected turn/start cancels its waiter without an unhandled rejection", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const leaked: unknown[] = [];
	const onLeak = (reason: unknown) => {
		leaked.push(reason);
	};
	process.on("unhandledRejection", onLeak);
	try {
		const prompt = session.prompt("hi", admission());
		const start = await fake.waitRequest("turn/start");
		start.reject(new Error("turn/start failed"));
		await expect(prompt).rejects.toThrow(/turn\/start failed/);
		await session.close();
		await Promise.resolve();
		await Promise.resolve();
		expect(leaked).toEqual([]);
	} finally {
		process.off("unhandledRejection", onLeak);
	}
});

test("close unsubscribes, settles waiters, interrupts the active turn, and does not close injected RPC", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	expect(fake.subscriberCount).toBeGreaterThan(0);
	expect(fake.requestHandlerCount).toBeGreaterThan(0);
	const prompt = session.prompt("hi", admission());
	void prompt.catch(() => undefined);
	const start = await fake.waitRequest("turn/start");
	start.resolve({
		turn: { id: "turn-close", items: [], status: "inProgress" },
	});
	fake.emit("turn/started", turnStarted(fake.thread.id, "turn-close"));
	const closing = session.close();
	const interrupt = await fake.waitRequest("turn/interrupt");
	expect((interrupt.params as { turnId?: string }).turnId).toBe("turn-close");
	interrupt.resolve({});
	await expect(prompt).rejects.toThrow(/closed|interrupt|EOF|aborted/i);
	await closing;
	expect(fake.closeCount).toBe(0);
	expect(fake.subscriberCount).toBe(0);
	expect(fake.requestHandlerCount).toBe(0);
	expect(session.hasActiveRun()).toBe(false);
});

test("abort during turn/start waits for the turn id and interrupts the native turn", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const controller = new AbortController();
	const prompt = session.prompt("hi", admission(controller.signal));
	const start = await fake.waitRequest("turn/start");
	controller.abort();
	start.resolve({
		turn: { id: "turn-race", items: [], status: "inProgress" },
	});
	const interrupt = await fake.waitRequest("turn/interrupt");
	expect((interrupt.params as { turnId?: string }).turnId).toBe("turn-race");
	interrupt.resolve({});
	fake.emit("turn/completed", {
		threadId: fake.thread.id,
		turn: { id: "turn-race", items: [], status: "interrupted" },
	});
	await expect(prompt).rejects.toThrow();
});

test("the admission abort signal still interrupts after turn/start has been acknowledged", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const prompt = session.prompt("hi", {
		signal: controller.signal,
		disposition: (value) => {
			if (value === "started") started.resolve();
		},
		rejected: () => undefined,
	});
	const start = await fake.waitRequest("turn/start");
	start.resolve({
		turn: { id: "turn-live", items: [], status: "inProgress" },
	});
	fake.emit("turn/started", turnStarted(fake.thread.id, "turn-live"));
	await started.promise;
	controller.abort();
	const interrupt = await fake.waitRequest("turn/interrupt");
	expect((interrupt.params as { turnId?: string }).turnId).toBe("turn-live");
	interrupt.resolve({});
	fake.emit("turn/completed", {
		threadId: fake.thread.id,
		turn: { id: "turn-live", items: [], status: "interrupted" },
	});
	await expect(prompt).rejects.toThrow();
});

test("each prompt refreshes model/list and usage reads last.totalTokens", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const listsAfterCreate = fake.methods.filter(
		(method) => method === "model/list",
	).length;
	expect(listsAfterCreate).toBe(1);
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	expect(fake.methods.filter((method) => method === "model/list").length).toBe(
		listsAfterCreate + 1,
	);
	start.resolve({ turn: { id: "turn-1", items: [], status: "inProgress" } });
	completeTurn(fake, "turn-1", "hi", { total: 99, last: 12 });
	await prompt;
	expect(session.usage()).toEqual({ tokens: 12, contextWindow: 128000 });
});

test("agent_settled hook failure is caught and surfaced as continuation_error", async () => {
	const fake = new FakeCodexRpc();
	const leaked: unknown[] = [];
	const onLeak = (reason: unknown) => {
		leaked.push(reason);
	};
	process.on("unhandledRejection", onLeak);
	try {
		const errorSeen = Promise.withResolvers<void>();
		const session = await openSession(fake, {
			register(host) {
				host.on("agent_settled", () => {
					throw new Error("memory observer failed");
				});
			},
		});
		session.subscribe((event) => {
			if (
				event &&
				typeof event === "object" &&
				"type" in event &&
				(event as { type?: string }).type === "continuation_error"
			)
				errorSeen.resolve();
		});
		const prompt = session.prompt("hi", admission());
		const start = await fake.waitRequest("turn/start");
		start.resolve({ turn: { id: "turn-1", items: [], status: "inProgress" } });
		completeTurn(fake, "turn-1", "hi");
		await prompt;
		await errorSeen.promise;
		expect(leaked).toEqual([]);
	} finally {
		process.off("unhandledRejection", onLeak);
	}
});

test("native turn completion calls host agent_settled before close", async () => {
	let settled = 0;
	const fake = new FakeCodexRpc();
	const first = Promise.withResolvers<void>();
	const session = await openSession(fake, {
		register(host) {
			host.on("agent_settled", () => {
				settled += 1;
				if (settled === 1) first.resolve();
			});
		},
	});
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	start.resolve({ turn: { id: "turn-1", items: [], status: "inProgress" } });
	completeTurn(fake, "turn-1", "hi");
	await prompt;
	await first.promise;
	expect(settled).toBe(1);
});

test("repeated turns with the same text keep distinct live journal identities", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	for (const turnId of ["turn-1", "turn-2"]) {
		const prompt = session.prompt("same", admission());
		const start = await fake.waitRequest("turn/start");
		start.resolve({ turn: { id: turnId, items: [], status: "inProgress" } });
		completeTurn(fake, turnId, "same");
		await prompt;
	}
	const users = session.history().flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as {
			id?: unknown;
			message?: { role?: string };
		};
		return item.message?.role === "user" && typeof item.id === "string"
			? [item.id]
			: [];
	});
	expect(users).toEqual(["codex:turn-1:user:0", "codex:turn-2:user:0"]);
});

test("native turns wait for completion rather than a fixed elapsed-time deadline", async () => {
	const fake = new FakeCodexRpc();
	const session = await openSession(fake);
	const callbacks: (() => void)[] = [];
	const realTimeout = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		_delay?: number,
		...args: unknown[]
	) => {
		callbacks.push(() => callback(...args));
		const handle = realTimeout(() => {}, 1000000);
		clearTimeout(handle);
		return handle;
	}) as typeof globalThis.setTimeout);
	let outcome = "pending";
	const prompt = session.prompt("wait for my approval", admission()).then(
		() => {
			outcome = "completed";
		},
		() => {
			outcome = "failed";
		},
	);
	try {
		const start = await fake.waitRequest("turn/start");
		start.resolve({
			turn: { id: "long-turn", items: [], status: "inProgress" },
		});
		await Promise.resolve();
		for (const fire of callbacks) fire();
		await Promise.resolve();
		await Promise.resolve();
		expect(outcome).toBe("pending");
		expect(session.hasActiveRun()).toBe(true);
	} finally {
		timer.mockRestore();
		completeTurn(fake, "long-turn", "wait for my approval");
		await prompt;
	}
	expect(outcome).toBe("completed");
});

test("settled hooks receive a usable lifecycle signal", async () => {
	const fake = new FakeCodexRpc();
	let aborted: boolean | undefined;
	const session = await openSession(fake, {
		register(host) {
			host.on("agent_settled", (_event, context) => {
				aborted = (context as { signal: AbortSignal }).signal.aborted;
			});
		},
	});
	const prompt = session.prompt("hi", admission());
	const start = await fake.waitRequest("turn/start");
	start.resolve({
		turn: { id: "settle-signal", status: "inProgress", items: [] },
	});
	completeTurn(fake, "settle-signal", "hi");
	await prompt;
	expect(aborted).toBe(false);
});
