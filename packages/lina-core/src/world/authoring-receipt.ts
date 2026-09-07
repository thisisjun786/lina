import type {
	EvaluatedEffect,
	EvaluationReceipt,
	WorldDraftPreview,
} from "./authoring-types.ts";
import { parseWorldPreviewOptions } from "./authoring-validation.ts";
import {
	array,
	digest,
	enumeration,
	finite,
	flag,
	identifier,
	jsonBoundary,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { fields, text, unique } from "./validation.ts";

function string(value: unknown): string {
	if (typeof value !== "string") throw Error("Invalid evaluated text");
	return value;
}
function ids(value: unknown): string[] {
	const values = array(value, identifier);
	unique(values, "receipt identifier");
	return values;
}
function scalar(value: unknown): void {
	if (typeof value === "number") finite(value);
	else if (typeof value !== "string" && typeof value !== "boolean")
		throw Error("Invalid evaluated scalar");
}
function effect(value: unknown): EvaluatedEffect {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid evaluated effect");
	switch (value.kind) {
		case "assign":
			fields(value, ["kind", "variableId", "value"]);
			identifier(value.variableId);
			scalar(value.value);
			break;
		case "event":
			fields(value, ["kind", "familyId", "actorIds", "summary"]);
			identifier(value.familyId);
			array(value.actorIds, identifier);
			string(value.summary);
			break;
		case "fact":
			fields(value, ["kind", "id", "text", "knownTo"]);
			identifier(value.id);
			string(value.text);
			array(value.knownTo, identifier);
			break;
		case "attitude":
			fields(value, ["kind", "fromAgentId", "toAgentId", "axisId", "delta"]);
			identifier(value.fromAgentId);
			identifier(value.toAgentId);
			identifier(value.axisId);
			finite(value.delta);
			break;
		case "goal":
			fields(value, ["kind", "agentId", "id", "description"]);
			identifier(value.agentId);
			identifier(value.id);
			string(value.description);
			break;
		default:
			throw Error("Unsupported evaluated effect");
	}
	return value as unknown as EvaluatedEffect;
}

/** Stored receipts are strict protocol objects, even when their checksums are internally consistent. */
export function parseEvaluationReceipt(value: unknown): EvaluationReceipt {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"agentId",
		"recipientId",
		"evaluationId",
		"inputDigest",
		"seed",
		"entries",
		"ruleIds",
		"effects",
		"variables",
		"draws",
		"truncated",
		"digest",
	]);
	if (value.version !== 1)
		throw Error("Unsupported evaluation receipt version");
	identifier(value.worldId);
	identifier(value.agentId);
	nullableId(value.recipientId);
	identifier(value.evaluationId);
	digest(value.inputDigest);
	text(value.seed, "evaluation seed");
	const entries = array(value.entries, (entry) => {
		fields(entry, ["id", "sourceId", "placement", "text"]);
		identifier(entry.id);
		identifier(entry.sourceId);
		enumeration(entry.placement, ["before", "after"]);
		string(entry.text);
		return entry;
	});
	unique(
		entries.map((entry) => entry.id as string),
		"evaluation entry",
	);
	ids(value.ruleIds);
	array(value.effects, effect);
	if (
		!value.variables ||
		typeof value.variables !== "object" ||
		Array.isArray(value.variables)
	)
		throw Error("Invalid evaluated variables");
	for (const [key, item] of Object.entries(value.variables)) {
		identifier(key);
		scalar(item);
	}
	const draws = array(value.draws, (draw) => {
		fields(draw, ["id", "value"]);
		const key = string(draw.id);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,1023}$/.test(key))
			throw Error("Invalid random draw id");
		const value = finite(draw.value);
		if (value < 0 || value >= 1) throw Error("Invalid random draw range");
		return { id: key, value };
	});
	unique(
		draws.map((draw) => draw.id),
		"evaluation draw",
	);
	flag(value.truncated);
	const { digest: savedDigest, ...body } = value;
	if (digest(savedDigest) !== lifeDigest(body))
		throw Error("Corrupt evaluation receipt digest");
	return structuredClone(value) as unknown as EvaluationReceipt;
}

export function parseWorldDraftPreview(value: unknown): WorldDraftPreview {
	jsonBoundary(value);
	fields(value, [
		"version",
		"draftId",
		"draftRevision",
		"worldId",
		"packDigest",
		"options",
		"unresolved",
		"changes",
		"evaluation",
		"canActivate",
		"digest",
	]);
	if (value.version !== 1) throw Error("Unsupported world preview version");
	identifier(value.draftId);
	revision(value.draftRevision, 1);
	identifier(value.worldId);
	if (value.packDigest !== null) digest(value.packDigest);
	const options = parseWorldPreviewOptions(value.options);
	const questions = array(value.unresolved, (question) => {
		fields(question, ["id", "question", "blocking"]);
		identifier(question.id);
		text(question.question, "preview question");
		flag(question.blocking);
		return question;
	});
	unique(
		questions.map((question) => question.id as string),
		"preview question",
	);
	fields(value.changes, [
		"addedAgents",
		"retiredAgents",
		"removedScenes",
		"changedPlaces",
		"changedRuleIds",
	]);
	for (const list of Object.values(value.changes)) ids(list);
	const evaluation =
		value.evaluation === null ? null : parseEvaluationReceipt(value.evaluation);
	const active = flag(value.canActivate);
	if (
		active &&
		(value.packDigest === null ||
			evaluation === null ||
			questions.some((question) => question.blocking))
	)
		throw Error("Impossible world preview readiness");
	if (
		evaluation &&
		(evaluation.worldId !== value.worldId ||
			evaluation.evaluationId !== value.draftId ||
			evaluation.agentId !== options.agentId ||
			evaluation.recipientId !== null ||
			evaluation.seed !== options.seed)
	)
		throw Error("World preview evaluation mismatch");
	const { digest: savedDigest, ...body } = value;
	if (digest(savedDigest) !== lifeDigest(body))
		throw Error("Corrupt world preview digest");
	return structuredClone(value) as unknown as WorldDraftPreview;
}
