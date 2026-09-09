import { expect, test } from "bun:test";
import { socialPack } from "../../lina-core/test/life-social-pack-fixture.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { engineInput, richPack } from "./social-fixtures/engine-input.ts";

const signal = () => new AbortController().signal;

test("R1 trace capacity cannot truncate candidates and change the selected effect", async () => {
	const pack = richPack();
	pack.social.triggers = [];
	const alternative = pack.social.actions.find((a) => a.id === "yes-b");
	if (alternative?.kind !== "terminal")
		throw Error("Missing alternate terminal");
	const delta = alternative.effects.find((e) => e.predicateId === "closeness");
	if (!delta) throw Error("Missing alternate effect");
	delta.value = 20;
	const input = engineInput(pack),
		engine = createEnsembleSocialEngine();
	const control = await engine.resolve(input, signal());
	expect(control.trace.terminalActionId).toBe("yes-a");
	expect(control.effects).toContainEqual({
		kind: "predicate",
		predicateId: "closeness",
		firstAgentId: "lina",
		secondAgentId: "mira",
		previous: 0,
		next: 10,
	});
	const sufficient = structuredClone(input);
	sufficient.limits.maxTraceEntries = 2;
	const same = await engine.resolve(sufficient, signal());
	expect(same.trace).toEqual(control.trace);
	expect(same.checkpoint).toEqual(control.checkpoint);
	expect(same.effects).toEqual(control.effects);
	const insufficient = structuredClone(input);
	insufficient.limits.maxTraceEntries = 1;
	await expect(engine.resolve(insufficient, signal())).rejects.toThrow();
	expect(insufficient.checkpoint.engineId).toBe("empty");
});

test("R2 a shared DAG terminal has one candidate ID and retains the winning path binding", async () => {
	const pack = socialPack();
	const root = pack.social.actions.find((a) => a.id === "greet");
	if (root?.kind !== "root") throw Error("Missing root");
	root.children = ["a", "b"];
	pack.social.actions.push(
		{
			id: "a",
			kind: "group",
			bindings: [{ id: "witness", roleId: "resident", agentId: "mira" }],
			conditions: [],
			influence: [{ conditions: [], weight: 1 }],
			children: ["greet-yes"],
		},
		{
			id: "b",
			kind: "group",
			bindings: [{ id: "witness", roleId: "resident", agentId: "sol" }],
			conditions: [],
			influence: [{ conditions: [], weight: 10 }],
			children: ["greet-yes"],
		},
	);
	const input = engineInput(pack);
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.outcome).toBe("accepted");
	expect(result.trace.candidateIds).toEqual(["greet-yes"]);
	expect(result.trace.terminalActionId).toBe("greet-yes");
	expect(Object.values(result.trace.bindings)).toContain("sol");
	const reduced = structuredClone(input);
	reduced.limits.maxTraceEntries = 1;
	const same = await createEnsembleSocialEngine().resolve(reduced, signal());
	expect(same.trace).toEqual(result.trace);
	expect(same.checkpoint).toEqual(result.checkpoint);
	expect(result.effects).toEqual([
		{
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 0,
			next: 1,
		},
	]);
});

test("R3 bootstrap historical conditions cannot match defaults before social step zero", async () => {
	const pack = socialPack();
	const root = pack.social.actions.find((a) => a.id === "greet");
	if (root?.kind !== "root") throw Error("Missing root");
	root.conditions = [
		{
			predicateId: "trust",
			first: { kind: "actor" },
			second: { kind: "target" },
			operator: "=",
			value: 0,
			window: { mostRecent: 2, leastRecent: 2 },
		},
	];
	const result = await createEnsembleSocialEngine().resolve(
		engineInput(pack),
		signal(),
	);
	expect(result.outcome).toBe("rejected");
	expect(result.trace.terminalActionId).toBeNull();
	expect(result.effects).toEqual([]);
});

test("R3 bootstrap windows overlapping step zero retain their existing-history match", async () => {
	const pack = socialPack();
	const root = pack.social.actions.find((a) => a.id === "greet");
	if (root?.kind !== "root") throw Error("Missing root");
	root.conditions = [
		{
			predicateId: "trust",
			first: { kind: "actor" },
			second: { kind: "target" },
			operator: "=",
			value: 0,
			window: { mostRecent: 1, leastRecent: 2 },
		},
	];
	const result = await createEnsembleSocialEngine().resolve(
		engineInput(pack),
		signal(),
	);
	expect(result.outcome).toBe("accepted");
	expect(result.effects).toEqual([
		{
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 0,
			next: 1,
		},
	]);
});

test("R2 tied DAG paths preserve distinct bindings for deterministic random selection", async () => {
	const { lifeDigest } = await import("../../lina-core/src/world/life-json.ts");
	const pack = socialPack();
	const root = pack.social.actions.find((a) => a.id === "greet");
	if (root?.kind !== "root") throw Error("Missing root");
	root.children = ["a", "b"];
	for (const [id, agentId] of [
		["a", "mira"],
		["b", "sol"],
	] as const)
		pack.social.actions.push({
			id,
			kind: "group",
			bindings: [{ id: "witness", roleId: "resident", agentId }],
			conditions: [],
			influence: [],
			children: ["greet-yes"],
		});
	const input = engineInput(pack);
	input.limits.maxTraceEntries = 1;
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, signal());
	const other = structuredClone(input);
	if (!other.bootstrap) throw Error("Missing bootstrap");
	other.bootstrap.seed = 1500;
	const { digest: _digest, ...bootstrap } = other.bootstrap;
	other.bootstrap.digest = lifeDigest(bootstrap);
	const second = await engine.resolve(other, signal());
	expect(first.trace.candidateIds).toEqual(["greet-yes"]);
	expect(second.trace.candidateIds).toEqual(["greet-yes"]);
	expect(Object.values(first.trace.bindings)).not.toContain("sol");
	expect(Object.values(second.trace.bindings)).toContain("sol");
	expect(first.effects).toEqual(second.effects);
});
