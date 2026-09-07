import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { CodexRpcOptions } from "../src/rpc.ts";

type Frame = {
	id?: string | number;
	method?: string;
	params: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
};
type Turn = { id: string; status: string; items: unknown[] };
type Thread = {
	id: string;
	turns: Turn[];
	status: { type: string };
	modelProvider: string;
};
export function contextRpc(root: string) {
	const input = new PassThrough(),
		output = new PassThrough();
	const path = join(root, "native-context-fixture.json");
	const threads: Thread[] = existsSync(path)
		? JSON.parse(readFileSync(path, "utf8"))
		: [];
	const frames: Frame[] = [];
	const queued: Frame[] = [];
	const waiters: Array<{ method: string; resolve: (frame: Frame) => void }> =
		[];
	let buffer = "",
		call = 0;
	const send = (frame: unknown) => {
		output.write(JSON.stringify(frame) + "\n");
	};
	const persist = () => writeFileSync(path, JSON.stringify(threads));
	let hook:
		| ((frame: Frame) => "drop" | "fail" | "lose-ack" | undefined)
		| undefined;
	input.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			const frame = JSON.parse(buffer.slice(0, end)) as Frame;
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
			frames.push(frame);
			const key = frame.method ?? `response:${frame.id}`;
			const waiter = waiters.find((w) => w.method === key);
			if (waiter) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			} else queued.push(frame);
			if (!frame.method || frame.id === undefined) continue;
			const action = hook?.(frame);
			if (action === "drop") continue;
			if (action === "fail") {
				send({
					id: frame.id,
					error: { code: -1, message: "synthetic failure" },
				});
				continue;
			}
			const params = frame.params ?? {};
			const thread = threads.find((t) => t.id === params["threadId"]);
			let result: unknown = {};
			switch (frame.method) {
				case "initialize":
					break;
				case "model/list":
					result = {
						data: [
							{
								id: "synthetic/companion-dialogue",
								model: "synthetic/companion-dialogue",
							},
						],
					};
					break;
				case "skills/list":
					result = { data: [] };
					break;
				case "thread/start": {
					const next: Thread = {
						id: `thread-${threads.length + 1}`,
						turns: [],
						status: { type: "idle" },
						modelProvider: "synthetic",
					};
					threads.push(next);
					persist();
					result = { thread: next };
					break;
				}
				case "thread/resume":
				case "thread/read":
					result = { thread };
					break;
				case "turn/start": {
					if (!thread) throw Error("Unknown fixture thread");
					const turn = {
						id: `turn-${thread.turns.length + 1}`,
						status: "inProgress",
						items: [],
					};
					thread.turns.push(turn);
					thread.status = { type: "active" };
					persist();
					result = { turn };
					if (action === "lose-ack") {
						output.end();
						continue;
					}
					if (action === "lose-ack") {
						output.end();
						continue;
					}
					send({ id: frame.id, result });
					send({
						method: "turn/started",
						params: { threadId: thread.id, turn },
					});
					continue;
				}
				case "turn/interrupt": {
					if (thread) {
						const turn = thread.turns.find((t) => t.id === params["turnId"]);
						if (turn) {
							turn.status = "interrupted";
							thread.status = { type: "idle" };
							persist();
							send({
								method: "turn/completed",
								params: { threadId: thread.id, turn },
							});
						}
					}
					break;
				}
				case "thread/compact/start":
					send({
						method: "thread/compacted",
						params: { threadId: params["threadId"] },
					});
					break;
				case "thread/name/set":
				case "thread/inject_items":
					break;
				default:
					throw Error(`Unexpected fixture method ${frame.method}`);
			}
			if (action === "lose-ack") {
				output.end();
				continue;
			}
			send({ id: frame.id, result });
		}
	});
	const next = (method: string): Promise<Frame> => {
		const index = queued.findIndex(
			(f) => (f.method ?? `response:${f.id}`) === method,
		);
		if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0] as Frame);
		return new Promise((resolve) => waiters.push({ method, resolve }));
	};
	return {
		frames,
		threads,
		options: {
			stdio: { input, output },
			ownsProcess: false,
			timeoutMs: 3000,
		} satisfies CodexRpcOptions,
		hook(fn: typeof hook) {
			hook = fn;
		},
		next,
		emit(method: string, params: unknown) {
			send({ method, params });
		},
		tool(threadId: string, toolName: string, args: unknown) {
			const id = `tool-${++call}`;
			send({
				id,
				method: "item/tool/call",
				params: { threadId, tool: toolName, callId: id, arguments: args },
			});
			return next(`response:${id}`);
		},
		complete(threadId: string, text = "hello") {
			const thread = threads.find((t) => t.id === threadId);
			const turn = thread?.turns.at(-1);
			if (!thread || !turn) throw Error("Missing fixture turn");
			turn.items = [
				{
					id: "same-user",
					type: "userMessage",
					content: [{ type: "text", text: "hi" }],
				},
				{
					id: "same-assistant",
					type: "agentMessage",
					text,
					phase: "final_answer",
				},
			];
			turn.status = "completed";
			thread.status = { type: "idle" };
			persist();
			for (const item of turn.items)
				send({
					method: "item/completed",
					params: { threadId, turnId: turn.id, item },
				});
			send({ method: "turn/completed", params: { threadId, turn } });
		},
		disconnect() {
			output.end();
		},
		close() {
			input.destroy();
			output.destroy();
		},
	};
}
