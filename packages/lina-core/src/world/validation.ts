import type {
	WorldDefinition,
	WorldFact,
	WorldProposal,
	WorldScene,
} from "./types.ts";

// Storage/validation ceilings, not schedules, model budgets or world defaults.
export const MAX_WORLD_BYTES = 1_000_000;
const MAX_ITEMS = 4096;
const MAX_TEXT = 32_768;
const PROPOSAL_FIELDS = [
	"worldId",
	"idempotencyKey",
	"expectedRevision",
	"simulationTime",
	"kind",
	"sceneId",
	"actorIds",
	"audience",
	"summary",
	"facts",
	"moves",
] as const;

export function fields<const K extends string>(
	value: unknown,
	names: readonly K[],
): asserts value is Record<K, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== names.length ||
		names.some((key) => !Object.hasOwn(value, key))
	)
		throw Error(
			"Invalid world fields; executable/import extensions are unsupported",
		);
}
export function integer(
	value: unknown,
	label: string,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < min ||
		(value as number) > max
	)
		throw Error(`Invalid world ${label}`);
}
export function text(
	value: unknown,
	label: string,
	empty = false,
): asserts value is string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		value.length > MAX_TEXT
	)
		throw Error(`Invalid world ${label}`);
}
export function id(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
	)
		throw Error("Invalid world id");
}
function list(value: unknown): asserts value is unknown[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS)
		throw Error("Invalid world list capacity");
}
export function unique(values: string[], label: string): void {
	if (new Set(values).size !== values.length)
		throw Error(`duplicate world ${label}`);
}
function ids(value: unknown): asserts value is string[] {
	list(value);
	for (const item of value) id(item);
	unique(value as string[], "id");
}
export function knownAgents(values: string[], agents: string[]): void {
	if (values.some((agent) => !agents.includes(agent)))
		throw Error("Unknown world agent");
}
function fact(value: unknown): asserts value is WorldFact {
	fields(value, ["id", "text", "knownTo"]);
	id(value.id);
	text(value.text, "fact text");
	ids(value.knownTo);
	if (!value.knownTo.length)
		throw Error("World fact requires a knowledge audience");
}
function scene(value: unknown): asserts value is WorldScene {
	fields(value, ["id", "placeId", "description", "occupants"]);
	id(value.id);
	id(value.placeId);
	text(value.description, "scene description", true);
	ids(value.occupants);
}
export function withinCapacity(value: unknown): void {
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_WORLD_BYTES)
		throw Error("World storage capacity exceeded");
}
export function parseDefinition(value: unknown): WorldDefinition {
	fields(value, [
		"id",
		"version",
		"title",
		"timeUnit",
		"initialTime",
		"agents",
		"places",
		"scenes",
		"lore",
	]);
	id(value.id);
	integer(value.version, "definition version", 1);
	text(value.title, "title");
	text(value.timeUnit, "time unit");
	integer(value.initialTime, "initial time");
	ids(value.agents);
	list(value.places);
	list(value.scenes);
	list(value.lore);
	for (const place of value.places) {
		fields(place, ["id", "name", "description"]);
		id(place.id);
		text(place.name, "place name");
		text(place.description, "place description", true);
	}
	for (const item of value.scenes) scene(item);
	for (const item of value.lore) fact(item);
	// Shape proven above; validate references before returning a detached copy.
	const definition = value as unknown as WorldDefinition;
	unique(
		definition.places.map((p) => p.id),
		"place",
	);
	unique(
		definition.scenes.map((s) => s.id),
		"scene",
	);
	unique(
		definition.scenes.flatMap((s) => s.occupants),
		"occupancy",
	);
	unique(
		definition.lore.map((f) => f.id),
		"fact",
	);
	for (const item of definition.scenes) {
		if (!definition.places.some((p) => p.id === item.placeId))
			throw Error("Unknown world place");
		knownAgents(item.occupants, definition.agents);
	}
	for (const item of definition.lore)
		knownAgents(item.knownTo, definition.agents);
	withinCapacity(definition);
	return {
		...structuredClone(definition),
		// JSON persists both signed zeros as 0; comparisons must use that same value.
		initialTime: definition.initialTime === 0 ? 0 : definition.initialTime,
	};
}
export function parseProposal(value: unknown): WorldProposal {
	const definitionChange =
		!!value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "definition";
	fields(
		value,
		definitionChange
			? [...PROPOSAL_FIELDS, "definition", "relocations"]
			: PROPOSAL_FIELDS,
	);
	id(value.worldId);
	id(value.idempotencyKey);
	integer(value.expectedRevision, "expected revision");
	integer(value.simulationTime, "simulation time");
	if (
		value.kind !== "activity" &&
		value.kind !== "tick" &&
		value.kind !== "definition"
	)
		throw Error("Invalid world event kind");
	if (value.sceneId !== null) id(value.sceneId);
	ids(value.actorIds);
	ids(value.audience);
	text(value.summary, "summary", true);
	list(value.facts);
	list(value.moves);
	for (const item of value.facts) fact(item);
	for (const move of value.moves) {
		fields(move, ["agentId", "sceneId"]);
		id(move.agentId);
		if (move.sceneId !== null) id(move.sceneId);
	}
	const proposal = value as unknown as WorldProposal;
	if (proposal.kind === "definition") {
		parseDefinition(proposal.definition);
		list(proposal.relocations);
		for (const move of proposal.relocations) {
			fields(move, ["agentId", "sceneId"]);
			id(move.agentId);
			if (move.sceneId !== null) id(move.sceneId);
		}
		unique(
			proposal.relocations.map((move) => move.agentId),
			"relocation",
		);
	}
	unique(
		proposal.facts.map((f) => f.id),
		"fact",
	);
	unique(
		proposal.moves.map((m) => m.agentId),
		"move",
	);
	withinCapacity(proposal);
	return {
		...structuredClone(proposal),
		...(proposal.kind === "definition"
			? { definition: parseDefinition(proposal.definition) }
			: {}),
		expectedRevision:
			proposal.expectedRevision === 0 ? 0 : proposal.expectedRevision,
		simulationTime: proposal.simulationTime === 0 ? 0 : proposal.simulationTime,
	};
}
