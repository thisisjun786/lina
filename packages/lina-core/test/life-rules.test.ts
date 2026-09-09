import { expect, test } from "bun:test";
import { evaluateWorld } from "../src/world/authoring.ts";
import type { Expression, RuleEffect } from "../src/world/authoring-types.ts";
import { parseWorldPack } from "../src/world/authoring-validation.ts";
import {
	authoringPack,
	evaluation,
	literal,
	loreEntry,
	read,
	rule,
} from "./life-authoring-fixture.ts";
import { required } from "./life-fixture.ts";

test("compile validates expression symbols, operand types, result types, ranges and division by zero", () => {
	const p = authoringPack();
	p.rules = [
		rule("r", {
			condition: { op: "gte", left: read("count"), right: literal(1) },
		}),
	];
	expect(parseWorldPack(p).rules).toHaveLength(1);
	const conditions: Expression[] = [
		read("missing"),
		read("count"),
		{ op: "gt", left: literal("text"), right: literal(1) },
		{ op: "not", value: literal(1) },
		{ op: "all", items: [literal(true), literal(2)] },
		{ op: "eq", left: literal(1), right: literal("1") },
	];
	for (const condition of conditions)
		expect(() =>
			parseWorldPack({ ...p, rules: [rule("r", { condition })] }),
		).toThrow();
	const values: Expression[] = [
		literal(true),
		literal(11),
		{ op: "random", id: "rng", min: 3, max: 2 },
		{ op: "div", left: literal(2), right: literal(0) },
		{ op: "mul", left: literal(Number.MAX_SAFE_INTEGER), right: literal(2) },
	];
	for (const value of values)
		expect(() =>
			parseWorldPack({
				...p,
				rules: [
					rule("r", {
						effects: [{ kind: "assign", variableId: "count", value }],
					}),
				],
			}),
		).toThrow();
});
test("compile checks visibility closure for conditions, text, assignment and effect destinations", () => {
	const p = authoringPack();
	const secret = read("secret");
	const leaks = [
		rule("r", { condition: { op: "eq", left: secret, right: literal("x") } }),
		rule("r", {
			effects: [
				{
					kind: "fact",
					id: "f",
					text: [{ kind: "value", expression: secret }],
					knownTo: [{ kind: "actor" }],
				},
			],
		}),
		rule("r", {
			effects: [
				{ kind: "assign", variableId: "secret", value: literal("overwrite") },
			],
		}),
		rule("r", {
			knownTo: ["sol"],
			effects: [{ kind: "assign", variableId: "flag", value: literal(true) }],
		}),
	];
	for (const r of leaks)
		expect(() => parseWorldPack({ ...p, rules: [r] })).toThrow();
	expect(() =>
		parseWorldPack({
			...p,
			lore: [
				loreEntry("leak", { text: [{ kind: "value", expression: secret }] }),
			],
		}),
	).toThrow();
	expect(() =>
		parseWorldPack({
			...p,
			constraints: [
				{
					id: "constraint",
					description: "leak",
					condition: { op: "eq", left: secret, right: literal("x") },
				},
			],
		}),
	).toThrow();
});
test("unknown families, axes, agents and retired targets reject before effects", () => {
	const effects: RuleEffect[] = [
		{
			kind: "event",
			familyId: "unknown",
			actorIds: [{ kind: "actor" }],
			summary: [],
		},
		{
			kind: "attitude",
			from: { kind: "actor" },
			to: { kind: "target" },
			axisId: "unknown",
			delta: literal(1),
		},
		{
			kind: "goal",
			agent: { kind: "agent", agentId: "ghost" },
			id: "g",
			description: [],
		},
	];
	for (const effect of effects)
		expect(() =>
			parseWorldPack({
				...authoringPack(),
				rules: [rule("r", { effects: [effect] })],
			}),
		).toThrow();
	const p = authoringPack();
	required(p.roles[1]).status = "retired";
	expect(() => evaluateWorld(p, evaluation())).toThrow();
});
test("typed arithmetic and every proposed effect leave caller state unchanged", () => {
	const p = authoringPack();
	p.eventFamilies = [
		{
			id: "visit",
			description: "Visit",
			actorRoleIds: ["resident"],
			condition: literal(true),
			weight: 1,
			effects: [],
		},
	];
	p.rules = [
		rule("r", {
			effects: [
				{
					kind: "assign",
					variableId: "count",
					value: { op: "div", left: literal(6), right: literal(2) },
				},
				{
					kind: "fact",
					id: "fact",
					knownTo: [{ kind: "actor" }],
					text: [
						{ kind: "text", text: "Count=" },
						{ kind: "value", expression: read("count") },
					],
				},
				{
					kind: "event",
					familyId: "visit",
					actorIds: [{ kind: "actor" }, { kind: "target" }],
					summary: [{ kind: "text", text: "Visit" }],
				},
				{
					kind: "attitude",
					from: { kind: "actor" },
					to: { kind: "target" },
					axisId: "relation",
					delta: literal(-1),
				},
				{
					kind: "goal",
					agent: { kind: "actor" },
					id: "goal",
					description: [{ kind: "text", text: "Look" }],
				},
			],
		}),
	];
	const input = evaluation();
	const before = JSON.stringify({ p, input });
	const receipt = evaluateWorld(p, input);
	expect(receipt.effects).toEqual([
		{ kind: "assign", variableId: "count", value: 3 },
		{ kind: "fact", id: "fact", knownTo: ["lina"], text: "Count=1" },
		{
			kind: "event",
			familyId: "visit",
			actorIds: ["lina", "mira"],
			summary: "Visit",
		},
		{
			kind: "attitude",
			fromAgentId: "lina",
			toAgentId: "mira",
			axisId: "relation",
			delta: -1,
		},
		{ kind: "goal", agentId: "lina", id: "goal", description: "Look" },
	]);
	expect(receipt.variables).toEqual({ flag: false, count: 3 });
	expect(JSON.stringify({ p, input })).toBe(before);
});
test("hidden values and hidden rules never change actor receipt, draw or budget", () => {
	const p = authoringPack();
	p.rules = [
		rule("visible", {
			probability: 0.7,
			effects: [
				{
					kind: "assign",
					variableId: "count",
					value: { op: "random", id: "pick", min: 0, max: 10 },
				},
			],
		}),
	];
	const before = evaluateWorld(p, evaluation());
	required(p.variables[2]).initial = "different-secret";
	p.rules.unshift(rule("a-hidden", { knownTo: ["sol"], probability: 0.3 }));
	const after = evaluateWorld(
		p,
		evaluation({ variables: { secret: "another-secret" } }),
	);
	expect(after).toEqual(before);
	expect(JSON.stringify(after)).not.toContain("secret");
});
test("runtime input type/range, scope, operation and recursion limits are enforced", () => {
	const p = authoringPack();
	p.rules = [
		rule("r", {
			condition: { op: "all", items: [literal(true), literal(true)] },
		}),
	];
	for (const patch of [
		{ variables: { count: 11 } },
		{ variables: { count: "1" } },
		{ variables: { unknown: 1 } },
		{ worldId: "elsewhere" },
		{ agentId: "ghost" },
	])
		expect(() => evaluateWorld(p, evaluation(patch))).toThrow();
	expect(() =>
		evaluateWorld(
			p,
			evaluation({ limits: { ...evaluation().limits, maxOperations: 1 } }),
		),
	).toThrow();
	let expression: Expression = literal(true);
	for (let i = 0; i < 40; i++) expression = { op: "not", value: expression };
	expect(() =>
		parseWorldPack({ ...p, rules: [rule("r", { condition: expression })] }),
	).toThrow();
});

test("nullable numeric bounds retain authored intent and runtime zero/overflow fail without partial effects", () => {
	const p = authoringPack();
	p.variables.push({
		id: "divisor",
		type: "number",
		initial: 2,
		min: null,
		max: null,
		knownTo: ["lina", "mira", "sol"],
	});
	p.rules = [
		rule("calculate", {
			effects: [
				{ kind: "assign", variableId: "flag", value: literal(true) },
				{
					kind: "assign",
					variableId: "count",
					value: { op: "div", left: literal(6), right: read("divisor") },
				},
			],
		}),
	];
	expect(
		parseWorldPack(p).variables.find((v) => v.id === "divisor"),
	).toMatchObject({ min: null, max: null });
	expect(evaluateWorld(p, evaluation()).variables).toMatchObject({ count: 3 });
	expect(() =>
		evaluateWorld(p, evaluation({ variables: { divisor: 0 } })),
	).toThrow("division by zero");
	expect(() =>
		evaluateWorld(p, evaluation({ variables: { divisor: 0.1 } })),
	).toThrow("out of range");
	required(p.rules[0]).effects[1] = {
		kind: "assign",
		variableId: "divisor",
		value: { op: "mul", left: read("divisor"), right: literal(2) },
	};
	expect(() =>
		evaluateWorld(
			p,
			evaluation({ variables: { divisor: Number.MAX_SAFE_INTEGER } }),
		),
	).toThrow("number");
	expect(required(p.variables[0]).initial).toBe(false);
});

test("all arithmetic and Boolean opcodes have finite typed results", () => {
	const cases: Array<[Expression, number | boolean]> = [
		[{ op: "add", left: literal(3), right: literal(2) }, 5],
		[{ op: "sub", left: literal(3), right: literal(2) }, 1],
		[{ op: "mul", left: literal(3), right: literal(2) }, 6],
		[{ op: "div", left: literal(3), right: literal(2) }, 1.5],
		[{ op: "eq", left: literal("x"), right: literal("x") }, true],
		[{ op: "ne", left: literal(false), right: literal(true) }, true],
		[{ op: "lt", left: literal(2), right: literal(3) }, true],
		[{ op: "lte", left: literal(3), right: literal(3) }, true],
		[{ op: "gt", left: literal(3), right: literal(2) }, true],
		[{ op: "gte", left: literal(3), right: literal(3) }, true],
		[{ op: "not", value: literal(false) }, true],
		[{ op: "all", items: [literal(true), literal(false)] }, false],
		[{ op: "any", items: [literal(false), literal(true)] }, true],
		[{ op: "all", items: [] }, true],
		[{ op: "any", items: [] }, false],
	];
	for (const [value, expected] of cases) {
		const variableId = typeof expected === "number" ? "count" : "flag";
		const p = authoringPack();
		p.rules = [rule("r", { effects: [{ kind: "assign", variableId, value }] })];
		expect(evaluateWorld(p, evaluation()).variables[variableId]).toBe(expected);
	}
});

test("random IDs are cached within each node and conflicting ranges reject", () => {
	const p = authoringPack();
	p.rules = [
		rule("r", {
			effects: [
				{
					kind: "assign",
					variableId: "count",
					value: { op: "random", id: "same", min: 1, max: 2 },
				},
				{
					kind: "fact",
					id: "draw",
					text: [
						{
							kind: "value",
							expression: { op: "random", id: "same", min: 1, max: 2 },
						},
					],
					knownTo: [{ kind: "actor" }],
				},
			],
		}),
	];
	const out = evaluateWorld(p, evaluation());
	expect(out.draws.filter((d) => d.id.includes("expression"))).toHaveLength(1);
	expect(out.effects[1]).toMatchObject({
		text: String(Reflect.get(out.variables, "count")),
	});
	required(p.rules[0]).effects.push({
		kind: "assign",
		variableId: "count",
		value: { op: "random", id: "same", min: 4, max: 5 },
	});
	expect(() => parseWorldPack(p)).toThrow("Conflicting");
});
