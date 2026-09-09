import type {
	DeclarativeRule,
	EvaluationInput,
	Expression,
	LifeConfigInput,
	LoreEntry,
	Scalar,
	WorldPack,
} from "../src/world/authoring-types.ts";
import { lifeDefinition } from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

export const literal = (value: Scalar): Expression => ({
	op: "literal",
	value,
});
export const read = (variableId: string): Expression => ({
	op: "read",
	variableId,
});
export function authoringPack(): WorldPack {
	return {
		schemaVersion: 1,
		worldId: "test-world",
		version: 1,
		background: {
			authoredText: "Only the author's setting",
			era: null,
			environment: null,
			description: null,
		},
		world: worldDefinition(),
		life: lifeDefinition(),
		constraints: [],
		roles: ["lina", "mira", "sol"].map((agentId) => ({
			agentId,
			roleId: "resident",
			description: "Example role",
			status: "active",
		})),
		variables: [
			{
				id: "flag",
				type: "boolean",
				initial: false,
				min: null,
				max: null,
				knownTo: ["lina", "mira", "sol"],
			},
			{
				id: "count",
				type: "number",
				initial: 1,
				min: 0,
				max: 10,
				knownTo: ["lina", "mira", "sol"],
			},
			{
				id: "secret",
				type: "string",
				initial: "hidden-value",
				min: null,
				max: null,
				knownTo: ["sol"],
			},
		],
		predicates: [],
		lore: [],
		rules: [],
		eventFamilies: [],
		unresolved: [],
		importReport: [],
	};
}
export function loreEntry(
	id: string,
	patch: Partial<LoreEntry> = {},
): LoreEntry {
	return {
		id,
		sourceId: id,
		primaryKeys: ["bell"],
		secondaryKeys: [],
		secondaryMode: "any",
		always: false,
		recursive: true,
		condition: literal(true),
		probability: 1,
		priority: 0,
		placement: "after",
		text: [{ kind: "text", text: id }],
		disclosure: {
			knowers: ["lina", "mira", "sol"],
			disclosures: [],
			publication: [],
		},
		effects: [],
		...patch,
	};
}
export function rule(
	id: string,
	patch: Partial<DeclarativeRule> = {},
): DeclarativeRule {
	return {
		id,
		condition: literal(true),
		probability: 1,
		priority: 0,
		knownTo: ["lina", "mira", "sol"],
		effects: [],
		...patch,
	};
}
export function evaluation(
	patch: Partial<EvaluationInput> = {},
): EvaluationInput {
	return {
		worldId: "test-world",
		agentId: "lina",
		targetAgentId: "mira",
		recipientId: null,
		evaluationId: "preview-1",
		seed: "test-seed",
		text: "bell",
		variables: {},
		limits: {
			maxChars: 10000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 10000,
		},
		...patch,
	};
}
export function unconfigured(): LifeConfigInput {
	return {
		version: 1,
		clock: null,
		run: null,
		models: null,
		limits: null,
		usage: null,
		publication: null,
		images: null,
		avatars: null,
	};
}
