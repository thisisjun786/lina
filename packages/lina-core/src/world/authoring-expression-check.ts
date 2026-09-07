import type {
	Expression,
	Scalar,
	VariableDefinition,
} from "./authoring-types.ts";
import { finite } from "./life-json.ts";

type ExpressionType = {
	type: VariableDefinition["type"];
	min: number | null;
	max: number | null;
};
export type ExpressionScope = {
	variables: Map<string, VariableDefinition>;
	audience: string[];
	randoms: Map<string, string>;
};
export function assertVisible(allowed: string[], audience: string[]): void {
	if (audience.some((id) => !allowed.includes(id)))
		throw Error("Authoring expression visibility violation");
}
export function checkVariableValue(
	variable: VariableDefinition,
	value: Scalar,
): void {
	if (typeof value !== variable.type)
		throw Error("Authoring variable type mismatch");
	if (typeof value === "number") {
		finite(value);
		if (
			(variable.min !== null && value < variable.min) ||
			(variable.max !== null && value > variable.max)
		)
			throw Error("Authoring variable out of range");
	}
}
function type(
	type: ExpressionType["type"],
	min: number | null = null,
	max: number | null = null,
): ExpressionType {
	return { type, min, max };
}
function expectType(
	actual: ExpressionType,
	expected: ExpressionType["type"],
): void {
	if (actual.type !== expected)
		throw Error("Authoring expression type mismatch");
}
export function checkExpression(
	expression: Expression,
	scope: ExpressionScope,
): ExpressionType {
	switch (expression.op) {
		case "literal":
			return typeof expression.value === "number"
				? type("number", expression.value, expression.value)
				: type(typeof expression.value === "string" ? "string" : "boolean");
		case "read": {
			const variable = scope.variables.get(expression.variableId);
			if (!variable) throw Error("Unknown authoring variable");
			assertVisible(variable.knownTo, scope.audience);
			return { type: variable.type, min: variable.min, max: variable.max };
		}
		case "random": {
			const signature = JSON.stringify([expression.min, expression.max]);
			const previous = scope.randoms.get(expression.id);
			if (previous !== undefined && previous !== signature)
				throw Error("Conflicting authoring random ID");
			scope.randoms.set(expression.id, signature);
			return type("number", expression.min, expression.max);
		}
		case "not":
			expectType(checkExpression(expression.value, scope), "boolean");
			return type("boolean");
		case "all":
		case "any":
			for (const item of expression.items)
				expectType(checkExpression(item, scope), "boolean");
			return type("boolean");
		default: {
			const left = checkExpression(expression.left, scope);
			const right = checkExpression(expression.right, scope);
			if (expression.op === "eq" || expression.op === "ne") {
				expectType(left, right.type);
				return type("boolean");
			}
			expectType(left, "number");
			expectType(right, "number");
			if (["lt", "lte", "gt", "gte"].includes(expression.op))
				return type("boolean");
			return arithmeticRange(expression.op, left, right);
		}
	}
}
function arithmeticRange(
	op: string,
	left: ExpressionType,
	right: ExpressionType,
): ExpressionType {
	if (op === "div" && right.min === 0 && right.max === 0)
		throw Error("Authoring division by zero");
	if (
		left.min === null ||
		left.max === null ||
		right.min === null ||
		right.max === null
	)
		return type("number");
	if (op === "div" && right.min <= 0 && right.max >= 0) return type("number");
	let values: number[];
	switch (op) {
		case "add":
			values = [left.min + right.min, left.max + right.max];
			break;
		case "sub":
			values = [left.min - right.max, left.max - right.min];
			break;
		case "mul":
			values = [
				left.min * right.min,
				left.min * right.max,
				left.max * right.min,
				left.max * right.max,
			];
			break;
		case "div":
			values = [
				left.min / right.min,
				left.min / right.max,
				left.max / right.min,
				left.max / right.max,
			];
			break;
		default:
			throw Error("Unsupported authoring arithmetic opcode");
	}
	return type(
		"number",
		finite(Math.min(...values)),
		finite(Math.max(...values)),
	);
}
export function checkBoolean(
	expression: Expression,
	scope: ExpressionScope,
): void {
	expectType(checkExpression(expression, scope), "boolean");
}
export function checkNumber(
	expression: Expression,
	scope: ExpressionScope,
): void {
	expectType(checkExpression(expression, scope), "number");
}
export function checkAssignment(
	variableId: string,
	expression: Expression,
	scope: ExpressionScope,
): void {
	const variable = scope.variables.get(variableId);
	if (!variable) throw Error("Unknown authoring assignment variable");
	// Both the assignment receipt and its future destination stay within the same audience.
	assertVisible(variable.knownTo, scope.audience);
	assertVisible(scope.audience, variable.knownTo);
	const result = checkExpression(expression, scope);
	expectType(result, variable.type);
	if (
		(result.min !== null &&
			variable.min !== null &&
			result.min < variable.min) ||
		(result.max !== null && variable.max !== null && result.max > variable.max)
	)
		throw Error("Authoring assignment range mismatch");
}
