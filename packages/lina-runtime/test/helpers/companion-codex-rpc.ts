import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CodexRpcOptions } from "../../../lina-codex/src/rpc.ts";

export const COMPANION_MODEL = "synthetic/companion-dialogue";

type Request = {
	id?: number;
	method: string;
	params: Record<string, unknown>;
};
type Turn = { id: string; params: Record<string, unknown> };

/** In-process app-server boundary; the real Codex RPC client owns serialization. */
export function createCompanionRpc(root: string) {
	const input = new PassThrough();
	const output = new PassThrough();
	const path = join(root, "companion-native-thread.json");
	const thread = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as {
				id: string;
				turns: unknown[];
			})
		: { id: "companion-native-thread", turns: [] as unknown[] };
	const requests: Request[] = [];
	const turns: Turn[] = [];
	const waiters: Array<(turn: Turn) => void> = [];
	let buffer = "";
	const reply = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
	const emit = (method: string, params: unknown) => reply({ method, params });
	const persist = () => writeFileSync(path, JSON.stringify(thread));
	const describe = () => ({
		...thread,
		path,
		status: { type: "idle" },
		modelProvider: "synthetic",
	});

	function handle(request: Request): void {
		requests.push(request);
		const { id, method, params } = request;
		if (id === undefined) return;
		let result: unknown;
		switch (method) {
			case "initialize":
				result = { userAgent: "companion-test" };
				break;
			case "model/list":
				result = { data: [{ id: COMPANION_MODEL, model: COMPANION_MODEL }] };
				break;
			case "skills/list":
				result = { data: [] };
				break;
			case "thread/start":
				persist();
				result = { thread: describe() };
				break;
			case "thread/resume":
			case "thread/read":
				if (params["threadId"] !== thread.id) {
					reply({ id, error: { code: -32600, message: "Unknown thread" } });
					return;
				}
				result = { thread: describe() };
				break;
			case "thread/name/set":
			case "thread/inject_items":
				result = {};
				break;
			case "turn/start": {
				const turn = {
					id: `companion-turn-${thread.turns.length + 1}`,
					params,
				};
				const started = { id: turn.id, items: [], status: "inProgress" };
				reply({ id, result: { turn: started } });
				emit("turn/started", { threadId: thread.id, turn: started });
				const waiter = waiters.shift();
				if (waiter) waiter(turn);
				else turns.push(turn);
				return;
			}
			case "turn/interrupt":
				reply({ id, result: {} });
				emit("turn/completed", {
					threadId: thread.id,
					turn: { id: params["turnId"], items: [], status: "interrupted" },
				});
				return;
			default:
				reply({ id, error: { code: -32601, message: `Unexpected ${method}` } });
				return;
		}
		reply({ id, result });
	}

	input.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (line.trim()) handle(JSON.parse(line) as Request);
			end = buffer.indexOf("\n");
		}
	});

	return {
		requests,
		threadId: thread.id,
		options: {
			stdio: { input, output },
			ownsProcess: false,
			timeoutMs: 3000,
		} satisfies CodexRpcOptions,
		nextTurn(): Promise<Turn> {
			const turn = turns.shift();
			return turn
				? Promise.resolve(turn)
				: new Promise((resolve) => waiters.push(resolve));
		},
		complete(turn: Turn): void {
			const items = [
				{
					type: "userMessage",
					id: `${turn.id}-user`,
					content: turn.params["input"],
				},
				{
					type: "agentMessage",
					id: `${turn.id}-assistant`,
					text: "반가워요.",
					phase: "final_answer",
				},
			];
			const completed = { id: turn.id, items, status: "completed" };
			thread.turns.push(completed);
			persist();
			for (const item of items)
				emit("item/completed", {
					threadId: thread.id,
					turnId: turn.id,
					completedAtMs: Date.now(),
					item,
				});
			emit("turn/completed", { threadId: thread.id, turn: completed });
		},
		close(): void {
			input.destroy();
			output.destroy();
		},
	};
}
