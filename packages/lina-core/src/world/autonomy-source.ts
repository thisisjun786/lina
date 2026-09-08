import { checkVariableValue } from "./authoring-expression-check.ts";
import type {
	EvaluationInput,
	Scalar,
	WorldPackV3,
} from "./authoring-types.ts";
import type { AutonomySource } from "./autonomy-types.ts";
import { lifeDigest } from "./life-json.ts";
export function assertAutonomyVariables(
	pack: WorldPackV3,
	variables: Record<string, Scalar>,
): void {
	if (Object.keys(variables).length !== pack.variables.length)
		throw Error("Autonomy variable map mismatch");
	for (const v of pack.variables) {
		const value = variables[v.id];
		if (!Object.hasOwn(variables, v.id) || value === undefined)
			throw Error("Missing autonomy variable");
		checkVariableValue(v, value);
	}
}
export function assertAutonomySource(source: AutonomySource): void {
	const { world, life, pack, autonomy } = source;
	if (
		world.definition.id !== pack.worldId ||
		life.worldId !== pack.worldId ||
		autonomy.worldId !== pack.worldId ||
		life.worldRevision !== world.revision ||
		autonomy.worldRevision !== world.revision ||
		autonomy.lifeRevision !== life.revision ||
		autonomy.packVersion !== pack.version ||
		world.definition.version !== pack.version ||
		life.definitionRevision !== pack.life.revision
	)
		throw Error("Autonomy source boundary mismatch");
	assertAutonomyVariables(pack, autonomy.variables);
	if (
		life.checkpoint.engineId === "ensemble" &&
		(life.checkpoint.data.worldRevision !== world.revision ||
			life.checkpoint.data.lifeRevision !== life.revision ||
			life.checkpoint.data.simulationTime !== world.simulationTime ||
			lifeDigest(life.checkpoint.data.variables) !==
				lifeDigest(autonomy.variables))
	)
		throw Error("Autonomy checkpoint variable boundary mismatch");
}
export function autonomyEvaluationInput(
	source: AutonomySource,
	stepId: string,
	agentId: string,
	targetAgentId: string | null = null,
	text = "",
): EvaluationInput {
	if (!source.config.limits)
		throw Error("Autonomy evaluation limits unconfigured");
	return {
		worldId: source.pack.worldId,
		agentId,
		targetAgentId,
		recipientId: null,
		evaluationId: stepId,
		seed: String(source.autonomy.seed),
		text,
		variables: { ...source.autonomy.variables },
		limits: source.config.limits.evaluation,
	};
}
