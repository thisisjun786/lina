/** Authored content and simulated events never establish real physical activity. */
export interface WorldFact {
	id: string;
	text: string;
	knownTo: string[];
}
export interface WorldPlace {
	id: string;
	name: string;
	description: string;
}
export interface WorldScene {
	id: string;
	placeId: string;
	description: string;
	occupants: string[];
}
export interface WorldDefinition {
	id: string;
	version: number;
	title: string;
	/** Caller-defined simulation unit, independent of wall time. */
	timeUnit: string;
	initialTime: number;
	agents: string[];
	places: WorldPlace[];
	scenes: WorldScene[];
	lore: WorldFact[];
}
export interface WorldActivityProposal {
	worldId: string;
	idempotencyKey: string;
	expectedRevision: number;
	simulationTime: number;
	kind: "activity" | "tick";
	sceneId: string | null;
	actorIds: string[];
	audience: string[];
	summary: string;
	facts: WorldFact[];
	moves: Array<{ agentId: string; sceneId: string | null }>;
}
export type WorldDefinitionProposal = Omit<WorldActivityProposal, "kind"> & {
	kind: "definition";
	definition: WorldDefinition;
	relocations: Array<{ agentId: string; sceneId: string | null }>;
};
export type WorldProposal = WorldActivityProposal | WorldDefinitionProposal;
export type WorldEvent = WorldProposal & {
	id: string;
	revision: number;
	acceptedAt: string;
	origin: "fictional";
	definitionVersion: number;
};
export interface WorldSnapshot {
	definition: WorldDefinition;
	revision: number;
	simulationTime: number;
	scenes: WorldScene[];
	facts: Array<WorldFact & { sourceEventId: string | null }>;
}
export interface WorldContextLimits {
	maxChars: number;
	maxFacts: number;
	maxEvents: number;
}
/** Agent projection: excludes audience lists and inaccessible scene/fact metadata. */
export interface WorldContext {
	worldId: string;
	agentId: string;
	definitionVersion: number;
	revision: number;
	simulationTime: number;
	timeUnit: string;
	origin: "fictional";
	scene: {
		id: string;
		place: WorldPlace;
		description: string;
		occupants: string[];
	} | null;
	facts: Array<{ id: string; text: string; sourceEventId: string | null }>;
	events: Array<{
		id: string;
		revision: number;
		simulationTime: number;
		summary: string;
		sceneId: string | null;
		actorIds: string[];
	}>;
	truncated: boolean;
}
