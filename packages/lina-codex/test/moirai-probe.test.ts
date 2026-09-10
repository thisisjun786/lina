import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MOIRAI_ROLES,
	MoiraiProbe,
	type ProbeGateway,
} from "../src/moirai-probe.ts";
import { verifyProbeHistory } from "../src/moirai-probe-state.ts";
import type { CodexRpc } from "../src/rpc.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(reuse?: string) {
	const root = reuse ?? mkdtempSync(join(tmpdir(), "moirai-round-test-"));
	if (!reuse) roots.push(root);
	const listeners = new Set<(method: string, params: unknown) => void>();
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
		onRequest() {
			return () => {};
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
		root,
		probe,
		pending,
		started,
		claims,
		entered,
		complete,
		emit,
		turns,
		gateway,
		resumed,
		get aggregates() {
			return aggregates;
		},
	};
}
test("three proposals overlap and aggregation waits for canonical plus captured success", async () => {
	const f = fixture();
	await f.probe.initialize();
	const aggregateEntered = Promise.withResolvers<void>();
	const original = f.gateway.expect;
	f.gateway.expect = (claim) => {
		original(claim);
		if (f.pending.length === 3) aggregateEntered.resolve();
	};
	const run = f.probe.round(
		"round1",
		"synthetic",
		new AbortController().signal,
	);
	await f.entered.promise;
	expect(f.pending).toHaveLength(3);
	expect(f.aggregates).toBe(0);
	f.emit("turn/completed", {
		threadId: "foreign",
		turn: { id: "turn-0", status: "completed" },
	});
	f.complete(2);
	f.complete(0);
	f.complete(1);
	await aggregateEntered.promise;
	// The aggregate request follows its registered transport claim.
	await Promise.resolve();
	f.complete(3);
	const results = await run;
	expect(results).toHaveLength(4);
	expect(f.aggregates).toBe(1);
	expect(new Set(results.map((r) => r.threadId)).size).toBe(4);
});
test("failed proposal prevents aggregate and retains failure", async () => {
	const f = fixture();
	await f.probe.initialize();
	const run = f.probe.round(
		"round2",
		"synthetic",
		new AbortController().signal,
	);
	void run.catch(() => {});
	await f.entered.promise;
	f.complete(0, "failed");
	f.complete(1);
	f.complete(2);
	await expect(run).rejects.toThrow();
	expect(f.aggregates).toBe(0);
	await expect(
		f.probe.round("round3", "next", new AbortController().signal),
	).rejects.toThrow();
});
test("native completed with failed gateway capture cannot aggregate", async () => {
	const f = fixture();
	f.gateway.settled = async () => {
		throw Error("capture failed");
	};
	await f.probe.initialize();
	const run = f.probe.round(
		"round4",
		"synthetic",
		new AbortController().signal,
	);
	void run.catch(() => {});
	await f.entered.promise;
	for (let i = 0; i < 3; i++) f.complete(i);
	await expect(run).rejects.toThrow();
	expect(f.aggregates).toBe(0);
});
test("changed native output cannot certify provider transmission or start aggregation", async () => {
	const f = fixture();
	f.gateway.settled = async () => ({
		usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
		text: "provider original",
		input: [],
		output: [],
	});
	await f.probe.initialize();
	const run = f.probe.round(
		"output-mismatch",
		"synthetic",
		new AbortController().signal,
	);
	void run.catch(() => {});
	await f.entered.promise;
	for (let i = 0; i < 3; i++) f.complete(i);
	// If aggregation incorrectly starts, finish it so the pre-fix test cannot hang.
	const prior = f.gateway.expect;
	f.gateway.expect = (claim) => {
		prior(claim);
		queueMicrotask(() => f.complete(3));
	};
	await expect(run).rejects.toThrow();
	expect(f.aggregates).toBe(0);
	const failure = JSON.parse(
		readFileSync(
			join(f.root, "round-output-mismatch", "failure-clotho.json"),
			"utf8",
		),
	);
	expect(failure.nativeResult.text).toBe("proposal-0");
	expect(failure.capturedResult.text).toBe("provider original");
	expect(failure.capturedResult.usage.total_tokens).toBe(3);
});
test("empty bound threads are not silently recreated after restart", async () => {
	const f = fixture();
	await f.probe.initialize();
	const next = fixture(f.root);
	await expect(next.probe.initialize()).rejects.toThrow();
	expect(next.pending).toHaveLength(0);
});
test("roles are the three named perspectives and Moirai", () => {
	expect(MOIRAI_ROLES).toEqual(["clotho", "lachesis", "atropos", "moirai"]);
});

test("aborted pending capture cannot hang the round or emit an aggregate", async () => {
	const f = fixture();
	f.gateway.settled = () => new Promise(() => {});
	await f.probe.initialize();
	const abort = new AbortController();
	const run = f.probe.round("round-abort", "synthetic", abort.signal);
	void run.catch(() => {});
	await f.entered.promise;
	abort.abort(Error("cancelled"));
	await expect(run).rejects.toThrow();
	expect(f.aggregates).toBe(0);
});
test("old turn completions cannot satisfy a current pending role", async () => {
	const f = fixture();
	await f.probe.initialize();
	const abort = new AbortController();
	const run = f.probe.round("round-old", "synthetic", abort.signal);
	void run.catch(() => {});
	await f.entered.promise;
	for (const p of f.pending)
		f.emit("turn/completed", {
			threadId: p.threadId,
			turn: { id: "old-turn", status: "completed" },
		});
	abort.abort(Error("cancelled after stale events"));
	await expect(run).rejects.toThrow();
	expect(f.aggregates).toBe(0);
});

for (const marker of [
	"",
	"{",
	JSON.stringify({ roundId: "wrong", results: [] }),
]) {
	test(`restart refuses invalid durable completion before any resume: ${marker || "empty"}`, async () => {
		const first = fixture();
		await first.probe.initialize();
		const directory = join(first.root, "round-damaged");
		mkdirSync(directory);
		writeFileSync(join(directory, "complete.json"), marker);
		const next = fixture(first.root);
		for (let i = 0; i < 4; i++)
			next.turns.set(`thread-${i}`, [{ id: `old-${i}`, status: "completed" }]);
		await expect(next.probe.initialize()).rejects.toThrow();
		expect(next.resumed).toEqual([]);
	});
}

test("restart validates every role against durable and native results before resuming", async () => {
	const f = fixture();
	await f.probe.initialize();
	const aggregateEntered = Promise.withResolvers<void>();
	const register = f.gateway.expect;
	f.gateway.expect = (claim) => {
		register(claim);
		if (f.pending.length === 3) aggregateEntered.resolve();
	};
	const run = f.probe.round("saved", "synthetic", new AbortController().signal);
	await f.entered.promise;
	for (let i = 0; i < 3; i++) f.complete(i);
	await aggregateEntered.promise;
	await Promise.resolve();
	f.complete(3);
	await run;
	const restart = () => {
		const next = fixture(f.root);
		for (const [id, history] of f.turns)
			next.turns.set(id, structuredClone(history));
		return next;
	};
	const good = restart();
	await good.probe.initialize();
	expect(good.resumed).toEqual([
		"thread-0",
		"thread-1",
		"thread-2",
		"thread-3",
	]);
	for (const mutation of ["failed", "wrong-text", "extra-turn"]) {
		const next = restart();
		const history = next.turns.get("thread-3");
		if (!history?.[0]) throw Error("Missing fixture history");
		if (mutation === "failed") history[0]["status"] = "failed";
		if (mutation === "wrong-text")
			history[0]["items"] = [{ type: "agentMessage", text: "different" }];
		if (mutation === "extra-turn")
			history.push({ id: "foreign", status: "completed" });
		await expect(next.probe.initialize()).rejects.toThrow();
		expect(next.resumed).toEqual([]);
	}
	const path = join(f.root, "round-saved", "result-moirai.json");
	const result = JSON.parse(readFileSync(path, "utf8"));
	result.turnId = "other-turn";
	writeFileSync(path, JSON.stringify(result));
	const next = restart();
	await expect(next.probe.initialize()).rejects.toThrow();
	expect(next.resumed).toEqual([]);
});

test("native input must be one exact text item, without hidden or malformed content", () => {
	const expected = {
		threadId: "thread",
		turns: new Map([["turn", { text: "answer", input: "original" }]]),
	};
	const history = (content: unknown[]) => ({
		thread: {
			id: "thread",
			turns: [
				{
					id: "turn",
					status: "completed",
					items: [
						{ type: "userMessage", content },
						{ type: "agentMessage", text: "answer" },
					],
				},
			],
		},
	});
	const text = { type: "text", text: "original", text_elements: [] };
	expect(() => verifyProbeHistory(history([text]), expected)).not.toThrow();
	for (const content of [
		[text, { type: "image", url: "synthetic.invalid/image" }],
		[text, { type: "text", text: "" }],
		[text, {}],
		[{ type: "image", text: "original" }],
		[{ type: "text", text: ["original"] }],
		[
			{ type: "text", text: "ori" },
			{ type: "text", text: "ginal" },
		],
	])
		expect(() => verifyProbeHistory(history(content), expected)).toThrow(
			"Native input evidence mismatch",
		);
});

test("ordered transport capture survives consecutive rounds and a fresh coordinator", async () => {
	const first = fixture();
	await first.probe.initialize();
	const finish = async (f: ReturnType<typeof fixture>, id: string) => {
		const index = f.pending.length;
		const run = f.probe.round(id, `input-${id}`, new AbortController().signal);
		await f.started(index + 2);
		for (let i = index; i < index + 3; i++) f.complete(i);
		await f.started(index + 3);
		f.complete(index + 3);
		return run;
	};
	const one = await finish(first, "z-first");
	const two = await finish(first, "a-second");
	for (const role of MOIRAI_ROLES)
		expect(first.claims.get(`a-second-${role}`)?.previous).toEqual(
			one.find((r) => r.role === role)?.capture,
		);
	const next = fixture(first.root);
	for (const [id, history] of first.turns)
		next.turns.set(id, structuredClone(history));
	await next.probe.initialize();
	expect(next.resumed).toHaveLength(4);
	await finish(next, "m-third");
	for (const role of MOIRAI_ROLES)
		expect(next.claims.get(`m-third-${role}`)?.previous).toEqual(
			two.find((r) => r.role === role)?.capture,
		);
	for (const [index, name] of ["z-first", "a-second", "m-third"].entries()) {
		for (const file of ["input", "complete"])
			expect(
				JSON.parse(
					readFileSync(
						join(first.root, `round-${name}`, `${file}.json`),
						"utf8",
					),
				).sequence,
			).toBe(index + 1);
	}
	const reordered = fixture(first.root);
	for (const [id, history] of next.turns)
		reordered.turns.set(id, structuredClone(history));
	reordered.turns.get("thread-3")?.reverse();
	await expect(reordered.probe.initialize()).rejects.toThrow();
	expect(reordered.resumed).toEqual([]);
});
