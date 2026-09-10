import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MoiraiProbe, type ProbeGateway } from "../src/moirai-probe.ts";
import type { CodexRpc, CodexRpcRequestHandler } from "../src/rpc.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
export function fixture(reuse?: string) {
	const root = reuse ?? mkdtempSync(join(tmpdir(), "moirai-round-test-"));
	if (!reuse) roots.push(root);
	const listeners = new Set<(method: string, params: unknown) => void>();
	const requestHandlers = new Set<CodexRpcRequestHandler>();
	const turns = new Map<string, Array<Record<string, unknown>>>();
	const pending: Array<{ threadId: string; id: string; text: string }> = [];
	const starts = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<void>>
	>();
	const started = (index: number) => {
		if (pending[index]) return Promise.resolve();
		let signal = starts.get(index);
		if (!signal) {
			signal = Promise.withResolvers<void>();
			starts.set(index, signal);
		}
		return signal.promise;
	};
	const entered = Promise.withResolvers<void>();
	let count = 0;
	let aggregates = 0;
	const resumed: string[] = [];
	const emit = (method: string, params: unknown) => {
		for (const l of listeners) l(method, params);
	};
	const rpc = {
		pid: 123,
		closed: false,
		subscribe(l: (method: string, params: unknown) => void) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		onRequest(handler: CodexRpcRequestHandler) {
			requestHandlers.add(handler);
			return () => requestHandlers.delete(handler);
		},
		notify() {},
		async close() {},
		async request(
			method: string,
			p: { threadId: string; input: Array<{ text: string }> },
		) {
			if (method === "thread/start") {
				const id = `thread-${count++}`;
				turns.set(id, []);
				return { thread: { id } };
			}
			if (method === "thread/resume") {
				resumed.push(p.threadId);
				return { thread: { id: p.threadId } };
			}
			if (method === "thread/read")
				return {
					thread: { id: p.threadId, turns: turns.get(p.threadId) ?? [] },
				};
			if (method === "turn/start") {
				const id = `turn-${turns.get(p.threadId)?.length ?? 0}-${pending.length}`;
				const text = p.input[0]?.text ?? "";
				pending.push({ threadId: p.threadId, id, text });
				starts.get(pending.length - 1)?.resolve();
				if (p.threadId === "thread-3") aggregates++;
				if (pending.length === 3) entered.resolve();
				return { turn: { id } };
			}
			throw Error(method);
		},
	} as unknown as CodexRpc;
	const claims = new Map<string, Parameters<ProbeGateway["expect"]>[0]>();
	const gateway: ProbeGateway = {
		expect(claim) {
			claims.set(claim.key, claim);
		},
		async settled(key) {
			const claim = claims.get(key);
			if (!claim) throw Error("Missing fixture claim");
			const text = `proposal-${claims.size - 1}`;
			return {
				usage: null,
				text,
				input: [
					...(claim.previous
						? [...claim.previous.input, ...claim.previous.output]
						: []),
					{
						role: "user",
						content: [{ type: "input_text", text: claim.input }],
					},
				],
				output: [
					{ role: "assistant", content: [{ type: "output_text", text }] },
				],
			};
		},
	};
	const probe = new MoiraiProbe({
		rpc,
		root,
		model: "test",
		threadParams: () => ({}),
		verifyThread: () => {},
		gateway,
	});
	const complete = (i: number, status = "completed") => {
		const p = pending[i];
		if (!p) throw Error("missing pending");
		const turn = {
			id: p.id,
			status,
			items: [
				{ type: "userMessage", content: [{ type: "text", text: p.text }] },
				{ type: "agentMessage", text: `proposal-${i}` },
			],
		};
		turns.get(p.threadId)?.push(turn);
		emit("turn/completed", { threadId: p.threadId, turn });
	};
	return {
		rpc,
		root,
		probe,
		pending,
		started,
		claims,
		entered,
		complete,
		emit,
		async actionRequest() {
			return Promise.allSettled(
				[...requestHandlers].map((handler) =>
					handler("item/tool/call", {}, () => {}),
				),
			);
		},
		turns,
		gateway,
		resumed,
		get aggregates() {
			return aggregates;
		},
	};
}

export async function finishProbeRound(
	f: ReturnType<typeof fixture>,
	id: string,
	shutdown?: () => Promise<void>,
) {
	const index = f.pending.length;
	const run = f.probe.round(
		id,
		`input-${id}`,
		new AbortController().signal,
		shutdown,
	);
	await f.started(index + 2);
	for (let i = index; i < index + 3; i++) f.complete(i);
	await f.started(index + 3);
	f.complete(index + 3);
	return run;
}
