import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finishProbeRound, fixture } from "./moirai-probe-fixture.ts";

function replaceUserText(
	turn: Record<string, unknown> | undefined,
	text: string,
) {
	const content = (
		turn?.["items"] as Array<{ content?: Array<{ text: string }> }> | undefined
	)?.[0]?.content?.[0];
	if (!content) throw Error("Missing fixture user content");
	content.text = text;
}

for (const activity of ["turn", "item", "request", "close-error", "clean"]) {
	test(`round keeps completion pending until guarded shutdown: ${activity}`, async () => {
		const f = fixture();
		await f.probe.initialize();
		let shutdownCalled = false;
		const run = finishProbeRound(f, "shutdown", async () => {
			shutdownCalled = true;
			expect(existsSync(join(f.root, "round-shutdown", "complete.json"))).toBe(
				false,
			);
			if (activity === "turn") f.emit("turn/started", { threadId: "thread-0" });
			if (activity === "item") f.emit("item/started", { threadId: "thread-1" });
			if (activity === "request") await f.actionRequest();
			if (activity === "close-error") throw Error("Owned shutdown failed");
			f.emit("eof", {});
		});
		if (activity === "clean") await run;
		else await expect(run).rejects.toThrow();
		expect(shutdownCalled).toBe(true);
		expect(existsSync(join(f.root, "round-shutdown", "complete.json"))).toBe(
			activity === "clean",
		);
		expect(existsSync(join(f.root, "round-shutdown", "failure.json"))).toBe(
			activity !== "clean",
		);
	});
}

for (const target of ["thread-0", "thread-1", "thread-2", "thread-3"]) {
	test(`native action requests during final reconciliation prevent completion: ${target}`, async () => {
		const f = fixture();
		await f.probe.initialize();
		const request = f.rpc.request.bind(f.rpc);
		let reads = 0;
		let observedSignal: AbortSignal | undefined;
		f.rpc.request = async <T>(
			method: string,
			params?: unknown,
			signal?: AbortSignal,
		): Promise<T> => {
			const result = await request<T>(method, params, signal);
			if (
				method === "thread/read" &&
				(params as { threadId: string }).threadId === target &&
				++reads === 2
			) {
				observedSignal = signal;
				const replies = await f.actionRequest();
				expect(replies[0]?.status).toBe("rejected");
			}
			return result;
		};
		await expect(finishProbeRound(f, "action")).rejects.toThrow(
			"Native action request forbidden",
		);
		expect(observedSignal?.aborted).toBe(true);
		expect(existsSync(join(f.root, "round-action", "complete.json"))).toBe(
			false,
		);
		expect(
			JSON.parse(
				readFileSync(join(f.root, "round-action", "failure.json"), "utf8"),
			).error,
		).toBe("Native action request forbidden");
		await expect(
			f.probe.round("later", "input", new AbortController().signal),
		).rejects.toThrow("Probe not ready");
	});
}

test("cross-role events after an earlier final read prevent completion", async () => {
	const f = fixture();
	await f.probe.initialize();
	const request = f.rpc.request.bind(f.rpc);
	let moiraiReads = 0;
	f.rpc.request = async <T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
		beforeSend?: () => void,
	): Promise<T> => {
		const result = await request<T>(method, params, signal, beforeSend);
		if (
			method === "thread/read" &&
			(params as { threadId: string }).threadId === "thread-3" &&
			++moiraiReads === 2
		) {
			const turn = { id: "late-turn", status: "completed", items: [] };
			f.turns.get("thread-0")?.push(turn);
			f.emit("turn/started", { threadId: "thread-0", turn });
		}
		return result;
	};
	await expect(finishProbeRound(f, "race")).rejects.toThrow();
	expect(existsSync(join(f.root, "round-race", "complete.json"))).toBe(false);
});

for (const mutation of [
	"source",
	"role",
	"round",
	"aggregate-source",
	"aggregate-proposal",
	"aggregate-order",
]) {
	test(`resume reconciles original source with role and aggregate inputs: ${mutation}`, async () => {
		const f = fixture();
		await f.probe.initialize();
		await finishProbeRound(f, "recorded");
		const dir = join(f.root, "round-recorded");
		const read = (name: string) =>
			JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
		const write = (name: string, value: unknown) =>
			writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
		if (mutation === "source")
			write("input", { ...read("input"), input: "changed original" });
		else {
			const role = mutation.startsWith("aggregate") ? "moirai" : "clotho";
			const intent = read(`intent-${role}`);
			const parsed = JSON.parse(intent.input);
			if (mutation === "role") parsed.role = "lachesis";
			if (mutation === "round") parsed.roundId = "other";
			if (mutation.startsWith("aggregate")) {
				const aggregate = JSON.parse(parsed.input);
				if (mutation === "aggregate-source") aggregate.input = "other source";
				if (mutation === "aggregate-proposal")
					aggregate.proposals[0].text = "fabricated";
				if (mutation === "aggregate-order") aggregate.proposals.reverse();
				parsed.input = JSON.stringify(aggregate);
			}
			intent.input = JSON.stringify(parsed);
			write(`intent-${role}`, intent);
			const result = read(`result-${role}`);
			result.capture.input.at(-1).content[0].text = intent.input;
			write(`result-${role}`, result);
			const complete = read("complete");
			complete.results[
				complete.results.findIndex((r: { role: string }) => r.role === role)
			] = result;
			write("complete", complete);
			const native = f.turns.get(result.threadId)?.[0];
			if (!native) throw Error("Missing fixture turn");
			replaceUserText(native, intent.input);
		}
		const next = fixture(f.root);
		for (const [id, turns] of f.turns)
			next.turns.set(id, structuredClone(turns));
		await expect(next.probe.initialize()).rejects.toThrow("source");
		expect(next.resumed).toEqual([]);
	});
}

for (const mutation of [
	"extra-turn",
	"changed-old-turn",
	"reordered",
	"changed-current-input",
	"late-extra-proposal-turn",
]) {
	test(`final native completion validates the whole snapshot: ${mutation}`, async () => {
		const f = fixture();
		await f.probe.initialize();
		await finishProbeRound(f, "first");
		const run = f.probe.round("final", "last", new AbortController().signal);
		void run.catch(() => {});
		await f.started(6);
		for (let i = 4; i < 7; i++) f.complete(i);
		await f.started(7);
		f.complete(7);
		const turns = f.turns.get("thread-3");
		if (!turns?.[0] || !turns[1]) throw Error("Missing fixture history");
		if (mutation === "extra-turn")
			turns.push({ id: "unintended", status: "completed", items: [] });
		if (mutation === "changed-old-turn")
			turns[0]["items"] = [
				{ type: "agentMessage", text: "altered old output" },
			];
		if (mutation === "reordered") turns.reverse();
		if (mutation === "changed-current-input")
			replaceUserText(turns[1], "changed current");
		if (mutation === "late-extra-proposal-turn")
			f.turns
				.get("thread-0")
				?.push({ id: "late", status: "completed", items: [] });
		await expect(run).rejects.toThrow();
		expect(existsSync(join(f.root, "round-final", "complete.json"))).toBe(
			false,
		);
		if (mutation !== "late-extra-proposal-turn")
			expect(
				existsSync(join(f.root, "round-final", "failure-moirai.json")),
			).toBe(true);
		const saved = JSON.parse(
			readFileSync(join(f.root, "round-final", "native-moirai.json"), "utf8"),
		);
		expect(saved.thread.turns).toEqual(turns);
	});
}
