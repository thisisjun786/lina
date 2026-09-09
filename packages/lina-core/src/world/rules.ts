import { checkVariableValue } from "./authoring-expression-check.ts";
import type {
	AgentReference,
	DeclarativeRule,
	EvaluatedEffect,
	EvaluationInput,
	EvaluationReceipt,
	Expression,
	RandomDraw,
	RuleEffect,
	Scalar,
	TextPart,
	WorldPack,
} from "./authoring-types.ts";
import { finite, lifeDigest } from "./life-json.ts";
import { MAX_WORLD_BYTES } from "./validation.ts";

export type EvaluatedCandidate = {
	id: string;
	priority: number;
	kind: "lore" | "rule";
	entry: EvaluationReceipt["entries"][number] | null;
	effects: EvaluatedEffect[];
};
export type EvaluationContext = {
	pack: WorldPack;
	input: EvaluationInput;
	variables: Readonly<Record<string, Scalar>>;
	draws: Map<string, RandomDraw>;
	operation: () => void;
	chargeText: (part: string) => void;
};
export function createEvaluationContext(
	pack: WorldPack,
	input: EvaluationInput,
): EvaluationContext {
	if (pack.worldId !== input.worldId)
		throw Error("Authoring evaluation world mismatch");
	const active = pack.roles
		.filter((r) => r.status === "active")
		.map((r) => r.agentId);
	if (
		!active.includes(input.agentId) ||
		(input.targetAgentId !== null && !active.includes(input.targetAgentId))
	)
		throw Error("Unknown or retired authoring evaluation actor");
	const definitions = new Map(pack.variables.map((v) => [v.id, v]));
	if (Object.keys(input.variables).some((id) => !definitions.has(id)))
		throw Error("Unknown authoring input variable");
	const variables = Object.fromEntries(
		pack.variables
			.filter((v) => visibleTo(v.knownTo, input))
			.map((v) => {
				const value = Object.hasOwn(input.variables, v.id)
					? input.variables[v.id]
					: v.initial;
				if (value === undefined)
					throw Error("Missing authoring input variable");
				checkVariableValue(v, value);
				return [v.id, value];
			}),
	);
	let operations = 0;
	let renderedBytes = 0;
	return {
		pack,
		input,
		variables: Object.freeze(variables),
		draws: new Map(),
		operation() {
			if (++operations > input.limits.maxOperations)
				throw Error("Authoring operation budget exceeded");
		},
		chargeText(part) {
			renderedBytes += Buffer.byteLength(part);
			if (renderedBytes > MAX_WORLD_BYTES)
				throw Error("Authoring rendered text capacity exceeded");
		},
	};
}
export function visibleTo(knownTo: string[], input: EvaluationInput): boolean {
	return (
		knownTo.includes(input.agentId) &&
		(input.recipientId === null || knownTo.includes(input.recipientId))
	);
}
/** Stable keyed draws consume no shared RNG state, including when another node is rejected. */
export function randomDraw(context: EvaluationContext, id: string): number {
	const cached = context.draws.get(id);
	if (cached) return cached.value;
	const input = context.input;
	const hash = lifeDigest([
		input.seed,
		input.worldId,
		input.evaluationId,
		input.agentId,
		input.targetAgentId,
		input.recipientId,
		id,
	]);
	const value = Number.parseInt(hash.slice(0, 13), 16) / 0x10000000000000;
	context.draws.set(id, { id, value });
	return value;
}
function number(value: Scalar): number {
	if (typeof value !== "number")
		throw Error("Authoring numeric operand required");
	return value;
}
function boolean(value: Scalar): boolean {
	if (typeof value !== "boolean")
		throw Error("Authoring boolean operand required");
	return value;
}
export function evaluateExpression(
	expression: Expression,
	context: EvaluationContext,
	key: string,
): Scalar {
	context.operation();
	switch (expression.op) {
		case "literal":
			return expression.value;
		case "read": {
			const value = context.variables[expression.variableId];
			if (
				value === undefined ||
				!Object.hasOwn(context.variables, expression.variableId)
			)
				throw Error("Unavailable authoring variable");
			return value;
		}
		case "random": {
			const draw = randomDraw(context, `${key}:expression:${expression.id}`);
			return finite(expression.min * (1 - draw) + expression.max * draw);
		}
		case "not":
			return !boolean(evaluateExpression(expression.value, context, key));
		case "all":
			return expression.items.every((item) =>
				boolean(evaluateExpression(item, context, key)),
			);
		case "any":
			return expression.items.some((item) =>
				boolean(evaluateExpression(item, context, key)),
			);
		default: {
			const left = evaluateExpression(expression.left, context, key);
			const right = evaluateExpression(expression.right, context, key);
			if (expression.op === "eq") return left === right;
			if (expression.op === "ne") return left !== right;
			const a = number(left);
			const b = number(right);
			switch (expression.op) {
				case "lt":
					return a < b;
				case "lte":
					return a <= b;
				case "gt":
					return a > b;
				case "gte":
					return a >= b;
				case "add":
					return finite(a + b);
				case "sub":
					return finite(a - b);
				case "mul":
					return finite(a * b);
				case "div":
					if (b === 0) throw Error("Authoring division by zero");
					return finite(a / b);
			}
		}
	}
}
export function evaluateText(
	parts: TextPart[],
	context: EvaluationContext,
	key: string,
): string {
	return parts
		.map((part) => {
			context.operation();
			const value =
				part.kind === "text"
					? part.text
					: String(evaluateExpression(part.expression, context, key));
			context.chargeText(value);
			return value;
		})
		.join("");
}
function agent(ref: AgentReference, context: EvaluationContext): string {
	const value =
		ref.kind === "agent"
			? ref.agentId
			: ref.kind === "actor"
				? context.input.agentId
				: context.input.targetAgentId;
	if (value === null) throw Error("Authoring effect requires a target actor");
	return value;
}
export function evaluateEffects(
	effects: RuleEffect[],
	context: EvaluationContext,
	key: string,
): EvaluatedEffect[] {
	return effects.map((effect) => evaluateEffect(effect, context, key));
}
function evaluateEffect(
	effect: RuleEffect,
	context: EvaluationContext,
	key: string,
): EvaluatedEffect {
	context.operation();
	switch (effect.kind) {
		case "assign": {
			const value = evaluateExpression(effect.value, context, key);
			const variable = context.pack.variables.find(
				(v) => v.id === effect.variableId,
			);
			if (!variable) throw Error("Unknown authoring assignment variable");
			checkVariableValue(variable, value);
			return { kind: "assign", variableId: effect.variableId, value };
		}
		case "event":
			return {
				kind: "event",
				familyId: effect.familyId,
				actorIds: [
					...new Set(effect.actorIds.map((ref) => agent(ref, context))),
				].sort(),
				summary: evaluateText(effect.summary, context, key),
			};
		case "fact":
			return {
				kind: "fact",
				id: effect.id,
				text: evaluateText(effect.text, context, key),
				knownTo: [
					...new Set(effect.knownTo.map((ref) => agent(ref, context))),
				].sort(),
			};
		case "attitude":
			return {
				kind: "attitude",
				fromAgentId: agent(effect.from, context),
				toAgentId: agent(effect.to, context),
				axisId: effect.axisId,
				delta: number(evaluateExpression(effect.delta, context, key)),
			};
		case "goal":
			return {
				kind: "goal",
				agentId: agent(effect.agent, context),
				id: effect.id,
				description: evaluateText(effect.description, context, key),
			};
	}
}
export function conditionPasses(
	condition: Expression,
	probability: number,
	context: EvaluationContext,
	key: string,
): boolean {
	return (
		boolean(evaluateExpression(condition, context, key)) &&
		randomDraw(context, `${key}:probability`) < probability
	);
}
export function evaluateRules(
	rules: DeclarativeRule[],
	context: EvaluationContext,
): EvaluatedCandidate[] {
	const result: EvaluatedCandidate[] = [];
	for (const rule of rules) {
		context.operation();
		const key = `rule:${rule.id}`;
		if (conditionPasses(rule.condition, rule.probability, context, key))
			result.push({
				id: rule.id,
				priority: rule.priority,
				kind: "rule",
				entry: null,
				effects: evaluateEffects(rule.effects, context, key),
			});
	}
	return result;
}
