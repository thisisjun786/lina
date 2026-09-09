import { expect, test } from "bun:test";
import { socialPack } from "../../lina-core/test/life-social-pack-fixture.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { engineInput } from "./social-fixtures/engine-input.ts";

const signal = () => new AbortController().signal;

test("real pinned resolution applies an actual directed effect and advances checkpoint", async () => {
	const input = engineInput();
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.kind).toBe("advanced");
	expect(result.outcome).toBe("accepted");
	expect(result.effects).toContainEqual({
		kind: "predicate",
		predicateId: "trust",
		firstAgentId: "lina",
		secondAgentId: "mira",
		previous: 0,
		next: 1,
	});
	expect(result.trace.rootActionId).toBe("greet");
	expect(result.trace.terminalActionId).toBe("greet-yes");
	expect(result.trace.drawsAfter).toBeGreaterThan(result.trace.drawsBefore);
	expect(input.checkpoint.engineId).toBe("empty");
	if (result.kind !== "advanced") throw Error("Missing checkpoint");
	expect(result.checkpoint.data.variableIntroductions).toEqual(
		["count", "flag", "secret"].map((id) => ({
			id,
			socialStep: 0,
			worldRevision: 0,
		})),
	);
});

test("composed transfer is conserved and move/goal proposals are emitted only on acceptance", async () => {
	const input = engineInput();
	input.intent.primitives.push(
		{ kind: "transfer", predicateId: "coins", toAgentId: "mira", amount: 2 },
		{ kind: "move", sceneId: "reading" },
		{ kind: "goal", goalId: "learn", description: "A new goal" },
	);
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.effects).toContainEqual({
		kind: "predicate",
		predicateId: "coins",
		firstAgentId: "lina",
		secondAgentId: null,
		previous: 5,
		next: 3,
	});
	expect(result.effects).toContainEqual({
		kind: "predicate",
		predicateId: "coins",
		firstAgentId: "mira",
		secondAgentId: null,
		previous: 5,
		next: 7,
	});
	expect(result.effects).toContainEqual({
		kind: "move",
		agentId: "lina",
		sceneId: "reading",
	});
	expect(result.effects).toContainEqual({
		kind: "goal",
		agentId: "lina",
		goalId: "learn",
		description: "A new goal",
	});
});

test("insufficient resources reject whole intention without successful social or move effects", async () => {
	const input = engineInput();
	input.intent.primitives.push(
		{ kind: "transfer", predicateId: "coins", toAgentId: "mira", amount: 6 },
		{ kind: "move", sceneId: "reading" },
	);
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.outcome).toBe("rejected");
	expect(result.effects).toEqual([]);
});

test("no eligible terminal is an advanced rejected attempt", async () => {
	const input = engineInput();
	input.targetResponse = {
		intentId: input.intent.id,
		agentId: "mira",
		decision: "reject",
	};
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.kind).toBe("advanced");
	expect(result.outcome).toBe("rejected");
	expect(result.effects).toEqual([]);
});

test("locked mapped identity cannot be changed by engine effects", async () => {
	const input = engineInput();
	const profile = input.identity.profiles.find((p) => p.agentId === "lina");
	if (!profile) throw Error("missing fixture profile");
	profile.lockedAttitudeIds = ["relation"];
	await expect(
		createEnsembleSocialEngine().resolve(input, signal()),
	).rejects.toThrow();
});

test("infinite action graphs and invalid primitives fail before dispatch", async () => {
	const pack = socialPack();
	const root = pack.social.actions.find((a) => a.kind === "root");
	if (root?.kind !== "root") throw Error("missing root");
	root.children = [root.id];
	expect(() => engineInput(pack)).toThrow();
});

test("typed rules use concrete identity, bindings, explicit negative acceptance and reciprocal trigger effects", async () => {
	const { richPack, continueInput } = await import(
		"./social-fixtures/engine-input.ts"
	);
	const input = engineInput(richPack());
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, signal());
	expect(first.trace.rootActionId).toBe("greet");
	expect(first.trace.candidateIds).toEqual(["yes-a", "yes-b"]);
	expect(first.effects).toContainEqual({
		kind: "predicate",
		predicateId: "closeness",
		firstAgentId: "lina",
		secondAgentId: "mira",
		previous: 0,
		next: 10,
	});
	expect(first.effects).toContainEqual({
		kind: "predicate",
		predicateId: "confident",
		firstAgentId: "sol",
		secondAgentId: null,
		previous: false,
		next: true,
	});
	const second = await engine.resolve(continueInput(input, first), signal());
	expect(second.trace.triggerIds).toEqual(["friendship-after-second"]);
	for (const [from, to] of [
		["lina", "mira"],
		["mira", "lina"],
	] as const)
		expect(second.effects).toContainEqual({
			kind: "predicate",
			predicateId: "friends",
			firstAgentId: from,
			secondAgentId: to,
			previous: false,
			next: true,
		});
});

test("positive volition cannot override explicit rejection and duration expires after restore", async () => {
	const { richPack, continueInput } = await import(
		"./social-fixtures/engine-input.ts"
	);
	const pack = richPack();
	const rule = pack.social.volitions[0];
	if (!rule?.effects[0]) throw Error("missing volition");
	rule.effects[0].weight = 40;
	let input = engineInput(pack);
	const engine = createEnsembleSocialEngine();
	let result = await engine.resolve(input, signal());
	for (let step = 0; step < 3; step++) {
		input = continueInput(input, result);
		input.targetResponse = {
			intentId: input.intent.id,
			agentId: "mira",
			decision: "reject",
		};
		result = await engine.resolve(input, signal());
		expect(result.outcome).toBe("rejected");
		expect(result.trace.terminalActionId).toBe("no");
	}
	expect(result.effects).toContainEqual({
		kind: "predicate",
		predicateId: "confident",
		firstAgentId: "sol",
		secondAgentId: null,
		previous: true,
		next: false,
	});
});

test("core request budgets bound real engine work and do not advance input", async () => {
	const input = engineInput();
	input.limits.maxOperations = 1;
	await expect(
		createEnsembleSocialEngine().resolve(input, signal()),
	).rejects.toThrow();
	expect(input.checkpoint.engineId).toBe("empty");
});

test("reveal requires current explicit authority and cannot inherit historical permission", async () => {
	const { lifeDigest } = await import("../../lina-core/src/world/life-json.ts");
	const pack = socialPack();
	const policy = {
		knowers: ["lina"],
		disclosures: [{ agentId: "lina", recipientId: "mira" }],
		publication: [],
	};
	pack.life.projection.disclosures = [
		{ subject: { kind: "world_fact", id: "secret" }, policy },
	];
	const input = engineInput(pack);
	input.intent.primitives.push({
		kind: "reveal",
		claim: { kind: "world_fact", id: "secret" },
		toAgentId: "mira",
	});
	input.policies = [
		{
			claim: { kind: "world_fact", id: "secret" },
			definitionRevision: 1,
			projectionRevision: 1,
			policyDigest: lifeDigest(policy),
		},
	];
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.effects).toContainEqual({
		kind: "reveal",
		fromAgentId: "lina",
		toAgentId: "mira",
		claim: { kind: "world_fact", id: "secret" },
	});
	const revoked = structuredClone(input);
	revoked.rulePack.life.projection.disclosures = [];
	const { digest: _digest, ...body } = revoked.rulePack;
	revoked.rulePack.digest = lifeDigest(body);
	await expect(
		createEnsembleSocialEngine().resolve(revoked, signal()),
	).rejects.toThrow("disclosure");
});

test("rootless supported primitives initialize an empty authored social schema", async () => {
	const pack = socialPack();
	pack.predicates = [];
	pack.social.policies = [];
	pack.social.actions = [];
	const capability = pack.social.capabilities[0];
	if (!capability) throw Error("missing capability");
	capability.rootActionId = null;
	capability.primitives = ["move", "goal"];
	const input = engineInput(pack);
	input.intent.primitives = [
		{ kind: "move", sceneId: "reading" },
		{ kind: "goal", goalId: "rest", description: "A new supported intention" },
	];
	const result = await createEnsembleSocialEngine().resolve(input, signal());
	expect(result.outcome).toBe("accepted");
	expect(result.trace.rootActionId).toBeNull();
	expect(result.effects).toEqual([
		{ kind: "move", agentId: "lina", sceneId: "reading" },
		{
			kind: "goal",
			agentId: "lina",
			goalId: "rest",
			description: "A new supported intention",
		},
	]);
});

test("sibling terminal alternatives do not consume each other's free role bindings", async () => {
	const { richPack } = await import("./social-fixtures/engine-input.ts");
	const pack = richPack();
	for (const action of pack.social.actions)
		for (const binding of action.bindings) binding.agentId = null;
	const result = await createEnsembleSocialEngine().resolve(
		engineInput(pack),
		signal(),
	);
	expect(result.trace.candidateIds).toEqual(["yes-a", "yes-b"]);
});

test("one shared trace budget covers candidates and trigger evidence", async () => {
	const { richPack, continueInput } = await import(
		"./social-fixtures/engine-input.ts"
	);
	const input = engineInput(richPack());
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, signal());
	const next = continueInput(input, first);
	next.limits.maxTraceEntries = 2;
	await expect(engine.resolve(next, signal())).rejects.toThrow();
});
