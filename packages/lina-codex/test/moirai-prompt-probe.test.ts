import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MOIRAI_ROLES, type ProbeExperiment } from "../src/moirai-probe.ts";
import { finishProbeRound, fixture } from "./moirai-probe-fixture.ts";

function experiment(): ProbeExperiment {
	return {
		instructions: {
			clotho: "one",
			lachesis: "two",
			atropos: "three",
			moirai: "four",
		},
		envelope: (roundId, role, input) =>
			JSON.stringify({ roundId, slot: MOIRAI_ROLES.indexOf(role), input }),
		synthesisInput: (input, results) =>
			JSON.stringify({ input, proposals: results.map((r) => r.text) }),
		validateOutput: () => undefined,
	};
}

test("experiment freezes instructions and sends neutral independent envelopes through the existing probe", async () => {
	const settings = experiment();
	const f = fixture(undefined, settings);
	Object.assign(settings.instructions, { clotho: "mutated" });
	await f.probe.initialize();
	const results = await finishProbeRound(f, "neutral");
	expect(results).toHaveLength(4);
	expect(
		f.threadStarts.map(
			(s) => (s as { baseInstructions: string }).baseInstructions,
		),
	).toEqual(["one", "two", "three", "four"]);
	expect([...f.claims.values()].map((c) => c.instructions)).toEqual([
		"one",
		"two",
		"three",
		"four",
	]);
	for (const p of f.pending) {
		expect(p.text).not.toMatch(/clotho|lachesis|atropos/);
	}
	for (const p of f.pending.slice(0, 3))
		expect(p.text).not.toContain("proposal-");
	expect(f.pending[3]?.text).toContain("proposal-0");
});

test("invalid proposal preserves raw output and failure while withholding synthesis", async () => {
	const spec = experiment();
	spec.validateOutput = (_round, role) => {
		if (role === "clotho") throw Error("wrong proposal ID");
		return undefined;
	};
	const f = fixture(undefined, spec);
	await f.probe.initialize();
	const run = f.probe.round("invalid", "fixed", new AbortController().signal);
	void run.catch(() => {});
	// Complete an incorrectly admitted aggregate too, so the RED fails without a timeout.
	void f.started(3).then(() => f.complete(3));
	await f.entered.promise;
	for (let i = 0; i < 3; i++) f.complete(i);
	await expect(run).rejects.toThrow("Proposal failed");
	expect(f.aggregates).toBe(0);
	expect(
		JSON.parse(
			readFileSync(join(f.root, "round-invalid/result-clotho.json"), "utf8"),
		).text,
	).toBe("proposal-0");
	expect(
		readFileSync(join(f.root, "round-invalid/failure-clotho.json"), "utf8"),
	).toContain("wrong proposal ID");
	expect(existsSync(join(f.root, "round-invalid/complete.json"))).toBe(false);
});

test("invalid synthesis is retained and never completes the experiment", async () => {
	const spec = experiment();
	spec.validateOutput = (_round, role) => {
		if (role === "moirai") throw Error("missing considered proposal");
		return undefined;
	};
	const f = fixture(undefined, spec);
	await f.probe.initialize();
	await expect(finishProbeRound(f, "synthesis")).rejects.toThrow(
		"missing considered proposal",
	);
	expect(f.aggregates).toBe(1);
	expect(
		readFileSync(join(f.root, "round-synthesis/result-moirai.json"), "utf8"),
	).toContain("proposal-3");
	expect(existsSync(join(f.root, "round-synthesis/complete.json"))).toBe(false);
});

test("experiment cannot execute a second round or resume through experiment or legacy mode", async () => {
	const f = fixture(undefined, experiment());
	await f.probe.initialize();
	await finishProbeRound(f, "once");
	expect(
		JSON.parse(readFileSync(join(f.root, "round-once/complete.json"), "utf8"))
			.resumable,
	).toBe(false);
	const second = f.probe.round("twice", "fixed", new AbortController().signal);
	void second.catch(() => {});
	void f.started(6).then(() => {
		for (let i = 4; i < 7; i++) f.complete(i);
	});
	void f.started(7).then(() => f.complete(7));
	await expect(second).rejects.toThrow("single round");
	expect(f.pending).toHaveLength(4);
	const next = fixture(f.root, experiment());
	await expect(next.probe.initialize()).rejects.toThrow("fresh ledger");
	expect(next.threadStarts).toHaveLength(0);
	const legacy = fixture(f.root);
	await expect(legacy.probe.initialize()).rejects.toThrow(
		"Invalid durable completion",
	);
	expect(legacy.resumed).toHaveLength(0);
});
