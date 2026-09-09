import { checkVariableValue } from "./authoring-expression-check.ts";
import type {
	EvaluationInput,
	Scalar,
	WorldPackV3,
} from "./authoring-types.ts";
import type { AutonomySource } from "./autonomy-types.ts";
import { lifeDigest } from "./life-json.ts";
import { parseLifeResolvedModels } from "./model-selection.ts";
import { parsePublicationAncestry } from "./publication-ancestry.ts";
import { parsePublicationBudget } from "./publication-budget.ts";
import { parsePublicationEvidence } from "./publication-input.ts";
import { parseWorkEvidence } from "./work-validation.ts";
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
	if (source.resolvedModels) {
		const models = parseLifeResolvedModels(source.resolvedModels);
		if (source.work?.version !== 2)
			throw Error("Frozen LIFE source requires work evidence v2");
		for (const lane of ["director", "actor"] as const) {
			const selected = models[lane],
				configured = source.config.models?.[lane];
			if (configured === null || configured === undefined) {
				if (selected !== null) throw Error("Unexpected resolved LIFE lane");
			} else if (
				!selected ||
				selected.provider !== configured.provider ||
				selected.model !== configured.model ||
				selected.settingsRevision !== source.modelSettingsRevision
			)
				throw Error("Resolved LIFE model source mismatch");
		}
	}
	if (source.work) {
		const work = parseWorkEvidence(source.work);
		if (
			work.worldId !== pack.worldId ||
			work.workConfigDigest !==
				lifeDigest(source.config.version === 2 ? source.config.work : null)
		)
			throw Error("Work source configuration mismatch");
	}
	if (source.publication || source.publicationAncestry) {
		const publication = parsePublicationEvidence(source.publication);
		const ancestry = parsePublicationAncestry(source.publicationAncestry);
		if (
			publication.worldId !== pack.worldId ||
			ancestry.some((row) => row.lifeRevision > life.revision)
		)
			throw Error("Publication source boundary mismatch");
		for (const record of publication.records) {
			const input = source.inputs.find((input) => input.id === record.inputId);
			if (
				input?.version !== 3 ||
				input.worldId !== pack.worldId ||
				lifeDigest(input.source) !== lifeDigest(record.source)
			)
				throw Error("Publication observation input mismatch");
		}
	}
	if (source.publicationBudget) {
		const budget = parsePublicationBudget(source.publicationBudget);
		if (
			budget.chain.worldId !== pack.worldId ||
			budget.settingsRevision !== source.publication?.authority.settingsRevision
		)
			throw Error("Publication budget source mismatch");
	}
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
