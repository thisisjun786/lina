import type {
	IdentityPolicySnapshot,
	LifeCommit,
	LifeDefinition,
} from "../src/world/life-types.ts";
import { worldActivity } from "./world-fixture.ts";

export function lifeDefinition(worldId = "test-world"): LifeDefinition {
	return {
		version: 1,
		worldId,
		revision: 1,
		participants: ["lina", "mira", "sol"],
		traits: [
			{ id: "axis", label: "Authored axis", min: -2, max: 2, initial: 0 },
		],
		habits: [{ id: "habit", label: "Authored habit", initial: false }],
		attitudes: [
			{
				id: "relation",
				label: "Authored attitude",
				min: -2,
				max: 2,
				initial: 0,
			},
		],
		projection: {
			revision: 1,
			sharedTraitIds: ["axis"],
			sharedHabitIds: ["habit"],
			sharedAttitudeIds: ["relation"],
			disclosures: [],
		},
	};
}
export function identityPolicy(): IdentityPolicySnapshot {
	return {
		version: 1,
		profiles: ["lina", "mira", "sol"].map((agentId) => ({
			agentId,
			profileRevision: 1,
			evolution: "adaptive",
			lockedTraitIds: [],
			lockedHabitIds: [],
			lockedAttitudeIds: [],
		})),
	};
}
export function lifeCommit(patch: Partial<LifeCommit> = {}): LifeCommit {
	return {
		version: 1,
		world: worldActivity(),
		expectedLifeRevision: 0,
		definitionRevision: 1,
		claims: [],
		beliefs: [],
		experiences: [],
		growth: [],
		checkpoint: {
			version: 1,
			engineId: "empty",
			engineRevision: 0,
			ruleDigest:
				"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
			encodingVersion: 1,
			dataDigest:
				"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
			data: null,
		},
		consumedInputIds: [],
		effects: [],
		...patch,
	};
}
export function socialCommit(): LifeCommit {
	return lifeCommit({
		claims: [
			{
				id: "false-claim",
				text: "The key is red",
				sourceEventId: "test-world:1",
				truth: "false",
				supersedes: null,
				disclosure: {
					knowers: ["lina", "mira"],
					disclosures: [],
					publication: [],
				},
			},
		],
		experiences: [
			{
				id: "told",
				agentId: "lina",
				eventId: "test-world:1",
				channel: "told",
				claims: [{ kind: "life_claim", id: "false-claim" }],
				simulationTime: 1,
			},
			{
				id: "witness",
				agentId: "mira",
				eventId: "test-world:1",
				channel: "direct",
				claims: [{ kind: "world_fact", id: "whisper" }],
				simulationTime: 1,
			},
		],
		beliefs: [
			{
				id: "belief-a",
				agentId: "lina",
				claim: { kind: "life_claim", id: "false-claim" },
				stance: "believes",
				confidence: "certain",
				experienceIds: ["told"],
				supersedes: null,
			},
		],
		growth: [
			{
				kind: "trait",
				agentId: "lina",
				axisId: "axis",
				previous: 0,
				next: 1,
				evidenceIds: ["told"],
			},
			{
				kind: "attitude",
				fromAgentId: "lina",
				toAgentId: "mira",
				axisId: "relation",
				previous: 0,
				next: -1,
				evidenceIds: ["told"],
			},
		],
	});
}

export function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("Missing synthetic fixture item");
	return value;
}
