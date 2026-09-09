import type {
	WorldActivityProposal,
	WorldDefinition,
} from "../src/world/index.ts";

export function worldDefinition(id = "test-world"): WorldDefinition {
	return {
		id,
		version: 1,
		title: "Synthetic world",
		timeUnit: "story-step",
		initialTime: 0,
		agents: ["lina", "mira", "sol"],
		places: [
			{
				id: "garden",
				name: "Test garden",
				description: "An authored test place",
			},
			{ id: "study", name: "Test study", description: "Another test place" },
		],
		scenes: [
			{
				id: "meeting",
				placeId: "garden",
				description: "A quiet meeting",
				occupants: ["lina", "mira"],
			},
			{
				id: "reading",
				placeId: "study",
				description: "Reading alone",
				occupants: ["sol"],
			},
		],
		lore: [{ id: "secret", text: "The hidden key is blue", knownTo: ["lina"] }],
	};
}

export function worldActivity(
	patch: Partial<WorldActivityProposal> = {},
): WorldActivityProposal {
	return {
		worldId: "test-world",
		idempotencyKey: "shared-event",
		expectedRevision: 0,
		simulationTime: 1,
		kind: "activity",
		sceneId: "meeting",
		actorIds: ["lina", "mira"],
		audience: ["lina", "mira"],
		summary: "A bell rang during the meeting",
		facts: [
			{ id: "bell", text: "The bell rang once", knownTo: ["lina", "mira"] },
			{
				id: "whisper",
				text: "Mira whispered a private word",
				knownTo: ["mira"],
			},
		],
		moves: [],
		...patch,
	};
}
