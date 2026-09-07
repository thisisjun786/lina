/** Isolated browser fixture: real Lina HTTP/storage/UI, synthetic native work engine. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CodexRpc,
	CodexRpcRequestHandler,
} from "../../packages/lina-codex/src/rpc.ts";
import { startCodexFleet } from "../../packages/lina-runtime/src/fleet/codex-fleet.ts";
import { loadWebAssets } from "../../packages/lina-web/src/assets.ts";
import { startWebServer } from "../../packages/lina-web/src/server.ts";

const root = mkdtempSync(join(tmpdir(), "lina-ui-codex-"));
const workspace = join(root, "work");
mkdirSync(workspace);
type Turn = { id: string; status: string; items: unknown[] };
type Thread = {
	id: string;
	cwd: string;
	name: string;
	model: string;
	status: { type: string; activeFlags?: string[] };
	turns: Turn[];
	canAcceptDirectInput: boolean;
	source: string;
};
const threads = new Map<string, Thread>();
const listeners = new Set<(method: string, params: unknown) => void>();
let requestHandler: CodexRpcRequestHandler | undefined;
const emit = (method: string, params: unknown) => {
	for (const fn of listeners) fn(method, params);
};
const rpc: CodexRpc = {
	closed: false,
	pid: undefined,
	async request<T>(method: string, params?: unknown): Promise<T> {
		const p = params as Record<string, unknown> | undefined;
		const thread = threads.get(String(p?.["threadId"]));
		let result: unknown = {};
		if (method === "thread/start") {
			const value: Thread = {
				id: randomUUID(),
				cwd: String(p?.["cwd"]),
				name: "QA task",
				model: "gpt-5.6-sol",
				status: { type: "idle" },
				turns: [],
				canAcceptDirectInput: true,
				source: "appServer",
			};
			threads.set(value.id, value);
			result = { thread: value, model: value.model };
		} else if (method === "thread/name/set" && thread)
			thread.name = String(p?.["name"]);
		else if ((method === "thread/read" || method === "thread/resume") && thread)
			result = { thread: structuredClone(thread) };
		else if (method === "thread/turns/list" && thread)
			result = { data: structuredClone(thread.turns), nextCursor: null };
		else if ((method === "turn/start" || method === "turn/steer") && thread) {
			const turn: Turn = {
				id: randomUUID(),
				status: "inProgress",
				items: [
					{
						type: "userMessage",
						id: randomUUID(),
						content: p?.["input"],
						clientId: p?.["clientRequestId"],
					},
				],
			};
			thread.turns.push(turn);
			thread.status = { type: "active", activeFlags: [] };
			result = { turn: structuredClone(turn) };
		} else if (method === "turn/interrupt" && thread) {
			const turn = thread.turns.at(-1);
			if (turn) {
				turn.status = "interrupted";
				thread.status = { type: "idle" };
				emit("turn/completed", {
					threadId: thread.id,
					turn: structuredClone(turn),
				});
			}
		} else if (method !== "initialize" && method !== "model/list")
			throw Error(`QA unsupported RPC ${method}`);
		return result as T;
	},
	notify() {},
	subscribe(fn) {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	},
	onRequest(fn) {
		requestHandler = fn;
		return () => {
			requestHandler = undefined;
		};
	},
	async close() {
		listeners.clear();
	},
};
const app = await startCodexFleet({
	workspace: process.cwd(),
	stateRoot: root,
	port: 0,
	createTaskRpc: async () => rpc,
	createApp: async () => {
		throw Error("UI fixture does not start model-consuming assistants");
	},
});
const kai = app.fleet.presets.find((p) => p.id === "kai");
if (kai) app.fleet.agents.create(kai);
const task = await app.tasks.create({
	ownerAgentId: "lina",
	title: "로그인 흐름 점검",
	cwd: workspace,
	prompt: "로그인 오류를 재현하고 수정 내용을 확인해줘.",
	requestId: "qa-seed",
});
if (task.threadId) {
	const thread = threads.get(task.threadId);
	const turn = thread?.turns.at(-1);
	if (thread && turn) {
		turn.items.push({
			type: "agentMessage",
			id: randomUUID(),
			text: "입력 검증과 재시도 흐름을 확인했습니다. 다음 변경은 승인을 기다립니다.",
		});
		thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
		void requestHandler?.("item/commandExecution/requestApproval", {
			threadId: thread.id,
			turnId: turn.id,
			itemId: "qa-command",
			command: "bun test",
			cwd: workspace,
		})
			.then(() => {
				thread.status = { type: "idle" };
				turn.status = "completed";
				emit("turn/completed", {
					threadId: thread.id,
					turn: structuredClone(turn),
				});
			})
			.catch(() => undefined);
	}
}
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${app.port}`,
	assets: await loadWebAssets(),
});
const info = {
	url: `http://127.0.0.1:${web.port}`,
	controller: app.port,
	root,
	taskId: task.id,
	syntheticTaskEngine: true,
	liveHub: true,
};
await Bun.write(
	new URL(
		"../../devlog/_plan/260906_codex_runtime/043_browser_server.json",
		import.meta.url,
	),
	JSON.stringify(info, null, 2) + "\n",
);
console.log(JSON.stringify(info));
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void web
		.stop(true)
		.then(() => app.stop())
		.then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
