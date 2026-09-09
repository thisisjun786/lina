import { authoringText } from "./authoring-node-validation.ts";
import {
	digest,
	enumeration,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

/** Exact host-resolved route stored with a new LIFE execution; no credentials. */
export interface LifeModelSelection {
	profileId: string;
	provider: string;
	model: string;
	reasoning: "off" | "low" | "medium" | "high";
	/** null preserves the provider default without inventing a product budget. */
	maxOutputTokens: number | null;
	settingsRevision: number;
	routeFingerprint: string;
}
export function parseLifeModelSelection(value: unknown): LifeModelSelection {
	jsonBoundary(value);
	fields(value, [
		"profileId",
		"provider",
		"model",
		"reasoning",
		"maxOutputTokens",
		"settingsRevision",
		"routeFingerprint",
	]);
	const selected = {
		profileId: identifier(value.profileId),
		provider: authoringText(value.provider),
		model: authoringText(value.model),
		reasoning: enumeration(value.reasoning, ["off", "low", "medium", "high"]),
		maxOutputTokens:
			value.maxOutputTokens === null
				? null
				: revision(value.maxOutputTokens, 1),
		settingsRevision: revision(value.settingsRevision),
	};
	const routeFingerprint = digest(value.routeFingerprint);
	if (routeFingerprint !== lifeDigest(selected))
		throw Error("LIFE model selection fingerprint mismatch");
	return { ...selected, routeFingerprint };
}

export interface LifeResolvedModels {
	director: LifeModelSelection | null;
	actor: LifeModelSelection | null;
}
export function parseLifeResolvedModels(value: unknown): LifeResolvedModels {
	fields(value, ["director", "actor"]);
	return {
		director:
			value.director === null ? null : parseLifeModelSelection(value.director),
		actor: value.actor === null ? null : parseLifeModelSelection(value.actor),
	};
}
