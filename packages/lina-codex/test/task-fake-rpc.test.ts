import { describe, expect, test } from "bun:test";
import type {
	TaskNotification,
	TaskRpc,
	TaskServerRequest,
} from "../src/task-rpc.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

type FakeTurn = {
	id: string;
	items: unknown[];
	itemsView: "full";
	status: "completed" | "interrupted" | "failed" | "inProgress";
	error: null;
	startedAt: number;
	completedAt: number | null;
	durationMs: number | null;
};

export type FakeThread = {
	id: string;
	extra: null;
	sessionId: string;
	forkedFromId: null;
	parentThreadId: null;
	preview: string;
	ephemeral: false;
	section: null;
	sectionEnteredAt: null;
	projectId: null;
	historyMode: "paginated";
	modelProvider: "opencodex";
	model: string | null;
	reasoningEffort: null;
	createdAt: number;
	updatedAt: number;
	recencyAt: number | null;
	status:
		| { type: "idle" }
		| { type: "active"; activeFlags: string[] }
		| { type: "notLoaded" }
		| { type: "systemError" };
	path: null;
	cwd: string;
	cliVersion: "0.153.4";
	source: "appServer" | "cli" | "vscode";
	canAcceptDirectInput: boolean | null;
	threadSource: string | null;
	agentNickname: null;
	agentRole: null;
	gitInfo: null;
	name: string | null;
	turns: FakeTurn[];
	archived?: boolean;
};

export class FakeCodexRpc implements TaskRpc {
	readonly log: { method: string; params: unknown }[] = [];
	readonly responses: { id: string | number; result: unknown }[] = [];
	readonly threads = new Map<string, FakeThread>();
	private readonly listeners = new Set<(n: TaskNotification) => void>();
	private readonly requestListeners = new Set<(r: TaskServerRequest) => void>();
	private readonly gates = new Map<string, Deferred<void>>();
	private readonly befores = new Map<string, () => void>();
	private readonly waiters = new Map<string, Deferred<void>[]>();
	private seq = 0;
	private approvalSeq = 0;

	calls(method: string): { method: string; params: unknown }[] {
		return this.log.filter((entry) => entry.method === method);
	}

	before(method: string, fn: () => void): void {
		this.befores.set(method, fn);
	}

	gate(method: string): void {
		this.gates.set(method, deferred());
	}

	release(method: string): void {
		this.gates.get(method)?.resolve();
		this.gates.delete(method);
	}

	waitUntilCalled(method: string): Promise<void> {
		if (this.log.some((entry) => entry.method === method))
			return Promise.resolve();
		const pending = deferred<void>();
		const list = this.waiters.get(method) ?? [];
		list.push(pending);
		this.waiters.set(method, list);
		return pending.promise;
	}

	emit(notification: TaskNotification): void {
		for (const listener of this.listeners) listener(notification);
	}

	emitRequest(request: TaskServerRequest): void {
		for (const listener of this.requestListeners) listener(request);
	}

	subscribe(listener: (notification: TaskNotification) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	subscribeRequests(
		listener: (request: TaskServerRequest) => void,
	): () => void {
		this.requestListeners.add(listener);
		return () => {
			this.requestListeners.delete(listener);
		};
	}

	async respond(id: string | number, result: unknown): Promise<void> {
		this.responses.push({ id, result });
		const thread = [...this.threads.values()].find(
			(item) =>
				item.status.type === "active" &&
				item.status.activeFlags.includes("waitingOnApproval"),
		);
		if (thread && thread.status.type === "active") {
			thread.status = {
				type: "active",
				activeFlags: thread.status.activeFlags.filter(
					(flag) => flag !== "waitingOnApproval",
				),
			};
			if (thread.status.activeFlags.length === 0)
				thread.status = { type: "active", activeFlags: [] };
			this.emit({
				method: "thread/status/changed",
				params: { threadId: thread.id, status: thread.status },
			});
		}
	}

	async request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		this.log.push({ method, params });
		const waiting = this.waiters.get(method);
		if (waiting) {
			this.waiters.delete(method);
			for (const waiter of waiting) waiter.resolve();
		}
		this.befores.get(method)?.();
		const gate = this.gates.get(method);
		if (gate) await this.abortable(gate.promise, signal);
		if (signal?.aborted) throw abortError(signal);
		return this.dispatch(method, params) as T;
	}

	completeTurn(
		threadId: string,
		status: "completed" | "interrupted" | "failed" = "completed",
	): FakeTurn {
		const thread = this.require(threadId);
		const turn =
			thread.turns.find((item) => item.status === "inProgress") ??
			thread.turns[thread.turns.length - 1];
		if (!turn) throw new Error("no turn");
		turn.status = status;
		turn.completedAt = Math.floor(Date.now() / 1000);
		thread.status = { type: "idle" };
		thread.updatedAt = turn.completedAt;
		this.emit({
			method: "turn/completed",
			params: { threadId, turn },
		});
		return turn;
	}

	addExternalMessage(threadId: string, text: string): void {
		const thread = this.require(threadId);
		const now = Math.floor(Date.now() / 1000);
		const turn: FakeTurn = {
			id: this.nextId("turn"),
			items: [
				{
					type: "userMessage",
					id: this.nextId("item"),
					clientId: null,
					content: [{ type: "text", text, text_elements: [] }],
				},
			],
			itemsView: "full",
			status: "completed",
			error: null,
			startedAt: now,
			completedAt: now,
			durationMs: 0,
		};
		thread.turns.push(turn);
		thread.updatedAt = now;
		thread.preview = text;
		thread.source = "cli";
	}

	unload(threadId: string): void {
		this.require(threadId).status = { type: "notLoaded" };
	}

	archive(threadId: string): void {
		this.require(threadId).archived = true;
	}

	requestApproval(threadId: string): TaskServerRequest {
		const request: TaskServerRequest = {
			id: `approval-${++this.approvalSeq}`,
			method: "item/commandExecution/requestApproval",
			params: {
				kind: "command",
				threadId,
				turnId: this.require(threadId).turns.at(-1)?.id ?? "turn",
				itemId: this.nextId("item"),
				startedAtMs: Date.now(),
				command: "ls",
			},
		};
		const thread = this.require(threadId);
		thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
		this.emitRequest(request);
		return request;
	}

	private async abortable<T>(
		promise: Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) throw abortError(signal);
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(abortError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	private dispatch(method: string, params: unknown): unknown {
		if (method === "thread/fork") throw new Error("fork fallback is forbidden");
		if (method === "thread/start") return this.start(params);
		if (method === "thread/read") return this.read(params);
		if (method === "thread/resume") return this.resume(params);
		if (method === "thread/name/set") return this.setName(params);
		if (method === "thread/turns/list") {
			const thread = this.require(this.threadId(params));
			return { data: thread.turns, nextCursor: null, backwardsCursor: null };
		}
		if (method === "turn/start") return this.turnStart(params);
		if (method === "turn/steer") return this.steer(params);
		if (method === "turn/interrupt") return this.interrupt(params);
		throw new Error(`unknown method ${method}`);
	}

	private start(params: unknown): unknown {
		const body = asRecord(params);
		const cwd = typeof body?.["cwd"] === "string" ? body["cwd"] : "/tmp";
		const model =
			typeof body?.["model"] === "string" ? body["model"] : "gpt-5.3-codex";
		const now = Math.floor(Date.now() / 1000);
		const thread: FakeThread = {
			id: this.nextId("thread"),
			extra: null,
			sessionId: this.nextId("session"),
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			section: null,
			sectionEnteredAt: null,
			projectId: null,
			historyMode: "paginated",
			modelProvider: "opencodex",
			model,
			reasoningEffort: null,
			createdAt: now,
			updatedAt: now,
			recencyAt: now,
			status: { type: "idle" },
			path: null,
			cwd,
			cliVersion: "0.153.4",
			source: "appServer",
			canAcceptDirectInput: true,
			threadSource:
				typeof body?.["threadSource"] === "string"
					? body["threadSource"]
					: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
		};
		this.threads.set(thread.id, thread);
		this.emit({ method: "thread/started", params: { thread } });
		return {
			thread,
			model,
			modelProvider: "opencodex",
			serviceTier: null,
			cwd,
			runtimeWorkspaceRoots: [cwd],
			instructionSources: [],
			approvalPolicy: "untrusted",
			approvalsReviewer: "user",
			sandbox: { type: "workspaceWrite" },
			activePermissionProfile: null,
			reasoningEffort: null,
			multiAgentMode: "explicitRequestOnly",
		};
	}

	private read(params: unknown): unknown {
		const thread = this.require(this.threadId(params));
		if (thread.archived) throw new Error("thread archived");
		return { thread };
	}

	private resume(params: unknown): unknown {
		const body = asRecord(params);
		if (body && (body["history"] || body["path"]))
			throw new Error("resume must use threadId only");
		const thread = this.require(this.threadId(params));
		if (thread.archived) throw new Error("thread archived");
		if (thread.status.type === "notLoaded") thread.status = { type: "idle" };
		return {
			thread,
			model: thread.model ?? "gpt-5.3-codex",
			modelProvider: thread.modelProvider,
			serviceTier: null,
			cwd: thread.cwd,
			runtimeWorkspaceRoots: [thread.cwd],
			instructionSources: [],
			approvalPolicy: "untrusted",
			approvalsReviewer: "user",
			sandbox: { type: "workspaceWrite" },
			activePermissionProfile: null,
			reasoningEffort: null,
			multiAgentMode: "explicitRequestOnly",
			initialTurnsPage: null,
			turnsBackwardsCursor: null,
			itemsBackwardsCursor: null,
		};
	}

	private setName(params: unknown): unknown {
		const thread = this.require(this.threadId(params));
		const body = asRecord(params);
		thread.name =
			typeof body?.["name"] === "string" ? body["name"] : thread.name;
		return {};
	}

	private turnStart(params: unknown): unknown {
		const thread = this.require(this.threadId(params));
		if (thread.turns.some((turn) => turn.status === "inProgress"))
			throw new Error("turn already active");
		const body = asRecord(params);
		const input = Array.isArray(body?.["input"]) ? body["input"] : [];
		const clientId =
			typeof body?.["clientUserMessageId"] === "string"
				? body["clientUserMessageId"]
				: null;
		const now = Math.floor(Date.now() / 1000);
		const turn: FakeTurn = {
			id: this.nextId("turn"),
			items: [
				{
					type: "userMessage",
					id: this.nextId("item"),
					clientId,
					content: input,
				},
			],
			itemsView: "full",
			status: "inProgress",
			error: null,
			startedAt: now,
			completedAt: null,
			durationMs: null,
		};
		thread.turns.push(turn);
		thread.status = { type: "active", activeFlags: [] };
		thread.updatedAt = now;
		this.emit({
			method: "turn/started",
			params: { threadId: thread.id, turn },
		});
		return { turn };
	}

	private steer(params: unknown): unknown {
		const thread = this.require(this.threadId(params));
		const body = asRecord(params);
		const expected =
			typeof body?.["expectedTurnId"] === "string"
				? body["expectedTurnId"]
				: "";
		const active = thread.turns.find((turn) => turn.status === "inProgress");
		if (!active || active.id !== expected)
			throw new Error("expectedTurnId does not match the active turn");
		const input = Array.isArray(body?.["input"]) ? body["input"] : [];
		const clientId =
			typeof body?.["clientUserMessageId"] === "string"
				? body["clientUserMessageId"]
				: null;
		active.items.push({
			type: "userMessage",
			id: this.nextId("item"),
			clientId,
			content: input,
		});
		return { turnId: active.id };
	}

	private interrupt(params: unknown): unknown {
		const thread = this.require(this.threadId(params));
		const body = asRecord(params);
		const turnId = typeof body?.["turnId"] === "string" ? body["turnId"] : "";
		const turn = thread.turns.find((item) => item.id === turnId);
		if (!turn) throw new Error("unknown turn");
		turn.status = "interrupted";
		turn.completedAt = Math.floor(Date.now() / 1000);
		thread.status = { type: "idle" };
		this.emit({
			method: "turn/completed",
			params: { threadId: thread.id, turn },
		});
		return {};
	}

	private threadId(params: unknown): string {
		const body = asRecord(params);
		if (typeof body?.["threadId"] !== "string")
			throw new Error("threadId required");
		return body["threadId"];
	}

	private require(id: string): FakeThread {
		const thread = this.threads.get(id);
		if (!thread) throw new Error("unknown thread");
		return thread;
	}

	private nextId(prefix: string): string {
		this.seq += 1;
		return `${prefix}-${this.seq}`;
	}
}

describe("FakeCodexRpc", () => {
	test("starts a native thread id without forking", async () => {
		const rpc = new FakeCodexRpc();
		const started = await rpc.request("thread/start", {
			cwd: "/tmp",
			threadSource: "lina",
		});
		const thread = asRecord(asRecord(started)?.["thread"]);
		expect(typeof thread?.["id"]).toBe("string");
		expect(rpc.calls("thread/fork")).toEqual([]);
	});
});
