import { expect, test } from "bun:test";
import { createEnsembleSocialEngine } from "../../lina-runtime/src/life/social/ensemble.ts";
import {
	continueInput,
	engineInput,
	richPack,
} from "../../lina-runtime/test/social-fixtures/engine-input.ts";
import type { WorldPackV2 } from "../src/world/authoring-types.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { validateSocialResult } from "../src/world/social.ts";
import { socialRecord } from "../src/world/social-checkpoint-validation.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../src/world/social-codec.ts";
import type {
	SocialCondition,
	SocialPredicateEffect,
	SocialResolution,
} from "../src/world/social-types.ts";
import { socialPredicateCategory } from "../src/world/social-views.ts";
import { required } from "./life-fixture.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

const first = { kind: "agent" as const, agentId: "lina" },
	second = { kind: "agent" as const, agentId: "mira" };
const trustWrite = (
	operator: SocialPredicateEffect["operator"],
	value: number,
): SocialPredicateEffect => ({
	predicateId: "trust",
	first,
	second,
	operator,
	value,
});
const trustCondition = (value: number): SocialCondition => ({
	predicateId: "trust",
	first,
	second,
	operator: "=",
	value,
	window: null,
});
function terminal(pack: WorldPackV2, effects: SocialPredicateEffect[]): void {
	const action = required(
		pack.social.actions.find((a) => a.kind === "terminal"),
	);
	if (action.kind !== "terminal") throw Error("Fixture terminal");
	action.effects = effects;
}
function resign(result: SocialResolution): void {
	if (result.checkpoint.engineId === "ensemble")
		result.checkpoint.dataDigest = lifeDigest(result.checkpoint.data);
	const { resultDigest: _, ...body } = result;
	result.resultDigest = lifeDigest(body);
}
function record(
	result: SocialResolution,
	predicateId: string,
	step?: number,
): Record<string, unknown> {
	if (result.kind !== "advanced") throw Error("Expected advanced result");
	const history = decodeSocialValue(result.checkpoint.data.state.history);
	if (!Array.isArray(history)) throw Error("Expected history");
	return required(
		(history[step ?? result.checkpoint.data.state.step] as unknown[])
			.map(socialRecord)
			.find(
				(r) =>
					r["category"] === socialPredicateCategory(predicateId) &&
					r["first"] === "lina",
			),
	);
}
function mutateHistory(
	result: SocialResolution,
	edit: (history: unknown[][], step: number) => void,
): SocialResolution {
	const forged = structuredClone(result);
	if (forged.kind !== "advanced") throw Error("Expected result");
	const history = decodeSocialValue(
		forged.checkpoint.data.state.history,
	) as unknown[][];
	edit(history, forged.checkpoint.data.state.step);
	forged.checkpoint.data.state.history = encodeSocialValue(history);
	resign(forged);
	return forged;
}

function forgeValue(result: SocialResolution, value: number): SocialResolution {
	const forged = structuredClone(result);
	if (forged.kind !== "advanced") throw Error("Expected advanced result");
	const history = decodeSocialValue(forged.checkpoint.data.state.history);
	if (!Array.isArray(history)) throw Error("Expected history");
	const row = required(
		(history[forged.checkpoint.data.state.step] as unknown[])
			.map(socialRecord)
			.find(
				(r) =>
					r["category"] === socialPredicateCategory("trust") &&
					r["first"] === "lina" &&
					r["second"] === "mira",
			),
	);
	row["value"] = value;
	forged.checkpoint.data.state.history = encodeSocialValue(history);
	forged.checkpoint.dataDigest = lifeDigest(forged.checkpoint.data);
	const effect = forged.effects.find(
		(e) =>
			e.kind === "predicate" &&
			e.predicateId === "trust" &&
			e.firstAgentId === "lina" &&
			e.secondAgentId === "mira",
	);
	if (effect?.kind === "predicate") {
		effect.next = value;
		if (effect.previous === value)
			forged.effects = forged.effects.filter((e) => e !== effect);
	} else if (value !== 0)
		forged.effects.push({
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 0,
			next: value,
		});
	const { resultDigest: _, ...body } = forged;
	forged.resultDigest = lifeDigest(body);
	return forged;
}

test("declared trust +1 cannot become -1, +2, or an omitted write after recomputing digests", async () => {
	const input = engineInput();
	const result = await createEnsembleSocialEngine().resolve(
		input,
		new AbortController().signal,
	);
	expect(validateSocialResult(input, result)).toEqual(result);
	expect(result.effects).toContainEqual({
		kind: "predicate",
		predicateId: "trust",
		firstAgentId: "lina",
		secondAgentId: "mira",
		previous: 0,
		next: 1,
	});
	for (const value of [-1, 2, 0])
		expect(() =>
			validateSocialResult(input, forgeValue(result, value)),
		).toThrow();
});

test.each([
	{ operator: "=" as const, value: -1 },
	{ operator: "-" as const, value: 1 },
])(
	"checks numeric $operator literal instead of the sign of the result",
	async ({ operator, value }) => {
		const pack = socialPack();
		terminal(pack, [trustWrite(operator, value)]);
		const input = engineInput(pack);
		const result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
		expect(record(result, "trust")["value"]).toBe(-1);
		expect(validateSocialResult(input, result)).toEqual(result);
		expect(() => validateSocialResult(input, forgeValue(result, -2))).toThrow();
	},
);

test("sequential assignment, per-write clamping, and condition-dependent triggers end at -1", async () => {
	const pack = socialPack();
	terminal(pack, [trustWrite("=", 2), trustWrite("+", 1), trustWrite("-", 1)]);
	pack.social.triggers = [
		{
			id: "a-first",
			bindings: [],
			conditions: [trustCondition(1)],
			effects: [trustWrite("-", 1)],
		},
		{
			id: "b-second",
			bindings: [],
			conditions: [trustCondition(0)],
			effects: [trustWrite("-", 1)],
		},
	];
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(record(result, "trust")["value"]).toBe(-1);
	expect(result.trace.triggerIds).toEqual(["a-first", "b-second"]);
	expect(validateSocialResult(input, result)).toEqual(result);
	for (const value of [0, 1, 2, -2])
		expect(() =>
			validateSocialResult(input, forgeValue(result, value)),
		).toThrow();
	const omitted = structuredClone(result);
	omitted.trace.triggerIds = ["a-first"];
	resign(omitted);
	expect(() => validateSocialResult(input, omitted)).toThrow();
});

test("one trigger ID represents three mandatory binding executions", async () => {
	const pack = socialPack();
	required(pack.predicates.find((p) => p.id === "trust")).max = 100;
	required(
		pack.social.policies.find((p) => p.predicateId === "trust"),
	).attitudeAxisId = null;
	terminal(pack, [trustWrite("+", 10)]);
	pack.social.triggers = [
		{
			id: "crowd",
			bindings: [{ id: "observer", roleId: "resident", agentId: null }],
			conditions: [],
			effects: [trustWrite("+", 1)],
		},
	];
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(record(result, "trust")["value"]).toBe(13);
	expect(result.trace.triggerIds).toEqual(["crowd"]);
	expect(validateSocialResult(input, result)).toEqual(result);
	expect(() => validateSocialResult(input, forgeValue(result, 11))).toThrow();
});

test.each(["capability", "root", "terminal"])(
	"a false private %s condition cannot be forged into acceptance",
	async (owner) => {
		const pack = socialPack(),
			condition: SocialCondition = {
				...trustCondition(2),
				first: second,
				second: first,
			};
		if (owner === "capability")
			required(pack.social.capabilities[0]).conditions = [condition];
		else
			required(pack.social.actions.find((a) => a.kind === owner)).conditions = [
				condition,
			];
		const input = engineInput(pack),
			result = await createEnsembleSocialEngine().resolve(
				input,
				new AbortController().signal,
			);
		expect(result.outcome).toBe("rejected");
		expect(validateSocialResult(input, result)).toEqual(result);
		if (result.kind !== "advanced") throw Error("Expected advanced result");
		const forged = structuredClone(result);
		forged.outcome = "accepted";
		forged.trace.rejection = null;
		forged.trace.terminalActionId = "greet-yes";
		forged.trace.candidateIds = ["greet-yes"];
		forged.trace.bindings = { initiator: "lina", responder: "mira" };
		resign(forged);
		expect(() => validateSocialResult(input, forged)).toThrow();
	},
);

function booleanPack(): WorldPackV2 {
	const pack = socialPack();
	pack.predicates.push({
		id: "confident",
		type: "boolean",
		direction: "undirected",
		initial: false,
		min: null,
		max: null,
	});
	pack.social.policies.push({
		predicateId: "confident",
		duration: 3,
		visibility: { kind: "public" },
		resource: false,
		attitudeAxisId: null,
	});
	terminal(pack, [
		{
			predicateId: "confident",
			first: { kind: "actor" },
			second: null,
			operator: "=",
			value: true,
		},
	]);
	pack.social.capabilities.push({
		...required(pack.social.capabilities[0]),
		id: "wait",
		primitives: ["goal"],
		rootActionId: null,
	});
	return pack;
}

test("Boolean assignment and a net-zero pair still require all writes and their metadata", async () => {
	const pack = booleanPack();
	const action = required(
		pack.social.actions.find((a) => a.kind === "terminal"),
	);
	if (action.kind !== "terminal") throw Error("Expected terminal");
	action.effects.push({ ...required(action.effects[0]), value: false });
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(result.effects).toEqual([]);
	expect(record(result, "confident")["value"]).toBe(false);
	expect(record(result, "confident")["duration"]).toBe(3);
	expect(validateSocialResult(input, result)).toEqual(result);
	const omitted = mutateHistory(result, (history, step) => {
		const row = required(
			required(history[step])
				.map(socialRecord)
				.find(
					(r) =>
						r["category"] === socialPredicateCategory("confident") &&
						r["first"] === "lina",
				),
		);
		row["timeHappened"] = 0;
	});
	expect(() => validateSocialResult(input, omitted)).toThrow();
});

test("duration, bootstrap history, IDs and time cannot be changed behind unchanged current values", async () => {
	const engine = createEnsembleSocialEngine(),
		input = engineInput(booleanPack());
	const firstResult = await engine.resolve(input, new AbortController().signal);
	expect(validateSocialResult(input, firstResult)).toEqual(firstResult);
	const changedBootstrap = mutateHistory(firstResult, (history) => {
		const row = required(
			required(history[0])
				.map(socialRecord)
				.find(
					(r) =>
						r["category"] === socialPredicateCategory("confident") &&
						r["first"] === "lina",
				),
		);
		row["value"] = true;
	});
	expect(() => validateSocialResult(input, changedBootstrap)).toThrow();
	const waiting = continueInput(input, firstResult);
	waiting.intent.capabilityId = "wait";
	waiting.intent.primitives = [
		{ kind: "goal", goalId: "wait", description: "Wait" },
	];
	const result = await engine.resolve(waiting, new AbortController().signal);
	expect(record(result, "confident")["duration"]).toBe(2);
	expect(validateSocialResult(waiting, result)).toEqual(result);
	const altered = mutateHistory(result, (history, step) => {
		const row = required(
			required(history[step])
				.map(socialRecord)
				.find(
					(r) =>
						r["category"] === socialPredicateCategory("confident") &&
						r["first"] === "lina",
				),
		);
		row["duration"] = 3;
	});
	expect(() => validateSocialResult(waiting, altered)).toThrow();
	const thirdInput = continueInput(waiting, result),
		third = await engine.resolve(thirdInput, new AbortController().signal);
	const fourthInput = continueInput(thirdInput, third),
		fourth = await engine.resolve(fourthInput, new AbortController().signal);
	expect(record(fourth, "confident")["value"]).toBe(false);
	expect(validateSocialResult(fourthInput, fourth)).toEqual(fourth);
	// Bypass receipt acceptance only in this oracle control: the forged timer has a
	// real future effect, despite an unchanged value at the forged boundary.
	const tamperedThirdInput = continueInput(waiting, altered);
	const tamperedThird = await engine.resolve(
		tamperedThirdInput,
		new AbortController().signal,
	);
	const tamperedFourth = await engine.resolve(
		continueInput(tamperedThirdInput, tamperedThird),
		new AbortController().signal,
	);
	expect(record(tamperedFourth, "confident")["value"]).toBe(true);
});

test("identity locks apply to intermediate writes even when the final value is unchanged", async () => {
	const pack = socialPack();
	terminal(pack, [trustWrite("+", 1), trustWrite("-", 1)]);
	const input = engineInput(pack),
		engine = createEnsembleSocialEngine(),
		result = await engine.resolve(input, new AbortController().signal);
	expect(result.effects).toEqual([]);
	expect(validateSocialResult(input, result)).toEqual(result);
	required(
		input.identity.profiles.find((p) => p.agentId === "lina"),
	).lockedAttitudeIds = ["relation"];
	result.inputDigest = lifeDigest(input);
	resign(result);
	await expect(
		engine.resolve(input, new AbortController().signal),
	).rejects.toThrow();
	expect(() => validateSocialResult(input, result)).toThrow(/locked/);
});

test("per-write numeric clamping permits an intermediate sum above the safe bound", async () => {
	const pack = socialPack();
	required(pack.predicates.find((p) => p.id === "trust")).max =
		Number.MAX_SAFE_INTEGER;
	required(
		pack.social.policies.find((p) => p.predicateId === "trust"),
	).attitudeAxisId = null;
	terminal(pack, [
		trustWrite("=", Number.MAX_SAFE_INTEGER),
		trustWrite("+", Number.MAX_SAFE_INTEGER),
	]);
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(record(result, "trust")["value"]).toBe(Number.MAX_SAFE_INTEGER);
	expect(validateSocialResult(input, result)).toEqual(result);
});

test("bootstrap historical conditions cannot observe values before introduction", async () => {
	const pack = socialPack();
	required(pack.social.actions.find((a) => a.kind === "terminal")).conditions =
		[{ ...trustCondition(0), window: { mostRecent: 2, leastRecent: 3 } }];
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(result.outcome).toBe("rejected");
	expect(validateSocialResult(input, result)).toEqual(result);
});

test("actual nested bindings, reciprocal metadata and explicit rejected branches remain compatible", async () => {
	const engine = createEnsembleSocialEngine(),
		input = engineInput(richPack()),
		result = await engine.resolve(input, new AbortController().signal);
	expect(validateSocialResult(input, result)).toEqual(result);
	const next = continueInput(input, result),
		secondResult = await engine.resolve(next, new AbortController().signal);
	expect(record(secondResult, "friends")["value"]).toBe(true);
	expect(validateSocialResult(next, secondResult)).toEqual(secondResult);
	const rejected = continueInput(next, secondResult);
	if (!rejected.targetResponse) throw Error("Expected target response");
	rejected.targetResponse.decision = "reject";
	const third = await engine.resolve(rejected, new AbortController().signal);
	expect(third.outcome).toBe("rejected");
	expect(third.trace.terminalActionId).toBe("no");
	expect(validateSocialResult(rejected, third)).toEqual(third);
});

test("paired transfers precede conditional triggers and insufficient resources cannot be accepted", async () => {
	const pack = socialPack();
	terminal(pack, []);
	pack.social.triggers = [
		{
			id: "gift",
			bindings: [],
			conditions: [
				{
					predicateId: "coins",
					first,
					second: null,
					operator: "=",
					value: 2,
					window: null,
				},
			],
			effects: [trustWrite("+", 1)],
		},
	];
	const input = engineInput(pack);
	input.intent.primitives.push({
		kind: "transfer",
		predicateId: "coins",
		toAgentId: "mira",
		amount: 3,
	});
	const engine = createEnsembleSocialEngine(),
		result = await engine.resolve(input, new AbortController().signal);
	expect(record(result, "coins")["value"]).toBe(2);
	expect(record(result, "trust")["value"]).toBe(1);
	expect(validateSocialResult(input, result)).toEqual(result);
	const insufficient = continueInput(input, result),
		denied = await engine.resolve(insufficient, new AbortController().signal);
	expect(denied.outcome).toBe("rejected");
	expect(record(denied, "coins")["value"]).toBe(2);
	expect(validateSocialResult(insufficient, denied)).toEqual(denied);
});

test("pinned action bindings can reuse the sole free participant within one node", async () => {
	const pack = socialPack(),
		action = required(pack.social.actions.find((a) => a.kind === "terminal"));
	action.bindings = ["one", "two"].map((id) => ({
		id,
		roleId: "resident",
		agentId: null,
	}));
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(result.outcome).toBe("accepted");
	expect(
		Object.entries(result.trace.bindings)
			.filter(([key]) => key.startsWith("b_"))
			.map(([, value]) => value),
	).toEqual(["sol", "sol"]);
	expect(validateSocialResult(input, result)).toEqual(result);
});

test("trigger conditions are reevaluated after each binding's immediate writes", async () => {
	const pack = socialPack();
	terminal(pack, []);
	pack.social.triggers = [
		{
			id: "crowd",
			bindings: [{ id: "observer", roleId: "resident", agentId: null }],
			conditions: [{ ...trustCondition(2), operator: "<" }],
			effects: [trustWrite("+", 1)],
		},
	];
	const input = engineInput(pack),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	expect(record(result, "trust")["value"]).toBe(2);
	expect(result.trace.triggerIds).toEqual(["crowd"]);
	expect(validateSocialResult(input, result)).toEqual(result);
	expect(() => validateSocialResult(input, forgeValue(result, 1))).toThrow();
});

test("pure effect replay respects operation, binding and action depth budgets", async () => {
	const input = engineInput(),
		result = await createEnsembleSocialEngine().resolve(
			input,
			new AbortController().signal,
		);
	for (const key of ["maxOperations", "maxBindings", "maxDepth"] as const) {
		const bounded = structuredClone(input),
			forged = structuredClone(result);
		bounded.limits[key] = 1;
		forged.inputDigest = lifeDigest(bounded);
		resign(forged);
		expect(() => validateSocialResult(bounded, forged)).toThrow(/budget|depth/);
	}
});
