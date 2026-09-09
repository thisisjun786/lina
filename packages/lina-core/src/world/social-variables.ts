import { checkVariableValue } from "./authoring-expression-check.ts";
import type { Scalar } from "./authoring-types.ts";
import { digest, identifier, lifeDigest, revision } from "./life-json.ts";
import type {
	SocialAutonomyInput,
	SocialResolveInput,
	SocialResolveInputV1,
} from "./social-types.ts";
import { fields } from "./validation.ts";

/** Structural boundary. The store separately binds this map to its accepted step source. */
export function parseSocialAutonomyInput(
	value: unknown,
	source: SocialResolveInputV1,
): SocialAutonomyInput {
	fields(value, [
		"stepId",
		"worldRevision",
		"lifeRevision",
		"stateDigest",
		"variables",
	]);
	const expectedIds = source.rulePack.variables.map((v) => v.id);
	fields(value.variables, expectedIds);
	const variables: Record<string, Scalar> = {};
	for (const variable of source.rulePack.variables) {
		const current = value.variables[variable.id];
		if (
			typeof current !== "string" &&
			typeof current !== "number" &&
			typeof current !== "boolean"
		)
			throw Error("Invalid accepted social variable");
		checkVariableValue(variable, current);
		Object.defineProperty(variables, variable.id, {
			value: current,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	const parsed = {
		stepId: identifier(value.stepId),
		worldRevision: revision(value.worldRevision),
		lifeRevision: revision(value.lifeRevision),
		stateDigest: digest(value.stateDigest),
		variables,
	};
	if (
		parsed.worldRevision !== source.world.revision ||
		parsed.lifeRevision !== source.life.revision
	)
		throw Error("Accepted social variable source mismatch");
	if (
		source.checkpoint.engineId === "ensemble" &&
		lifeDigest(variables) !== lifeDigest(source.checkpoint.data.variables)
	)
		throw Error("Accepted social variables disagree with checkpoint");
	return parsed;
}

export function socialInputVariables(
	input: SocialResolveInput,
): Record<string, Scalar> {
	if (input.version === 2) return structuredClone(input.autonomy.variables);
	return input.checkpoint.engineId === "ensemble"
		? structuredClone(input.checkpoint.data.variables)
		: Object.fromEntries(
				input.rulePack.variables.map((v) => [v.id, v.initial]),
			);
}
