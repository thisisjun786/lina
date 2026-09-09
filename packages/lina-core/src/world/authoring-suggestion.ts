import type {
	AuthoringQuestion,
	WorldSuggestionContent,
	WorldSuggestionResult,
} from "./authoring-types.ts";
import { parseWorldPack } from "./authoring-validation.ts";
import { jsonBoundary } from "./life-json.ts";
import { fields, id, text, unique } from "./validation.ts";

export function parseAuthoringQuestions(value: unknown): AuthoringQuestion[] {
	jsonBoundary(value);
	if (!Array.isArray(value) || !value.length || value.length > 64)
		throw Error("Invalid incomplete authoring questions");
	const questions = value.map((item) => {
		fields(item, ["id", "question", "blocking"]);
		id(item.id);
		text(item.question, "authoring question");
		if (item.question.length > 4096 || typeof item.blocking !== "boolean")
			throw Error("Invalid incomplete authoring question");
		return { id: item.id, question: item.question, blocking: item.blocking };
	});
	unique(
		questions.map((question) => question.id),
		"authoring question",
	);
	if (!questions.some((question) => question.blocking))
		throw Error("Incomplete world requires a blocking question");
	return questions;
}

/** Model wire: a complete WorldPack, or explicit questions without a guessed world. */
export function parseWorldSuggestionContent(
	value: unknown,
): WorldSuggestionContent {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"pack" in value &&
		value.pack === null
	) {
		fields(value, ["pack", "unresolved"]);
		return {
			pack: null,
			unresolved: parseAuthoringQuestions(value.unresolved),
		};
	}
	return { pack: parseWorldPack(value) };
}

/** Trusted provider provenance is supplied separately by the runtime, never by model output. */
export function parseWorldSuggestionResult(
	value: unknown,
): WorldSuggestionResult {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"pack" in value &&
		value.pack === null
	) {
		fields(value, ["pack", "unresolved", "provider", "model"]);
		text(value.provider, "provider");
		text(value.model, "model");
		return {
			pack: null,
			unresolved: parseAuthoringQuestions(value.unresolved),
			provider: value.provider,
			model: value.model,
		};
	}
	fields(value, ["pack", "provider", "model"]);
	text(value.provider, "provider");
	text(value.model, "model");
	return {
		pack: parseWorldPack(value.pack),
		provider: value.provider,
		model: value.model,
	};
}
