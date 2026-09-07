import type { WorldPackV2 } from "../src/world/authoring-types.ts";
import type { SocialIntent } from "../src/world/social-types.ts";
import { authoringPack } from "./life-authoring-fixture.ts";

export function socialPack(): WorldPackV2 {
	return {
		...authoringPack(),
		schemaVersion: 2,
		predicates: [
			{
				id: "trust",
				type: "number",
				direction: "directed",
				initial: 0,
				min: -2,
				max: 2,
			},
			{
				id: "coins",
				type: "number",
				direction: "undirected",
				initial: 5,
				min: 0,
				max: 10,
			},
		],
		social: {
			version: 1,
			policies: [
				{
					predicateId: "trust",
					duration: null,
					visibility: { kind: "first" },
					resource: false,
					attitudeAxisId: "relation",
				},
				{
					predicateId: "coins",
					duration: null,
					visibility: { kind: "public" },
					resource: true,
					attitudeAxisId: null,
				},
			],
			triggers: [],
			volitions: [],
			actions: [
				{
					id: "greet",
					kind: "root",
					bindings: [],
					conditions: [],
					influence: [],
					intent: { predicateId: "trust", intentType: true },
					children: ["greet-yes"],
				},
				{
					id: "greet-yes",
					kind: "terminal",
					bindings: [],
					conditions: [],
					influence: [],
					acceptance: "accepted",
					effects: [
						{
							predicateId: "trust",
							first: { kind: "actor" },
							second: { kind: "target" },
							operator: "+",
							value: 1,
						},
					],
				},
			],
			capabilities: [
				{
					id: "socialize",
					description: "An authored capability",
					actorRoleIds: ["resident"],
					targetRoleIds: ["resident"],
					knownTo: ["lina", "mira", "sol"],
					primitives: ["move", "attempt", "transfer", "reveal", "goal"],
					rootActionId: "greet",
					conditions: [],
				},
			],
		},
	};
}

export function socialIntent(): SocialIntent {
	return {
		id: "intent-1",
		agentId: "lina",
		targetAgentId: "mira",
		capabilityId: "socialize",
		description: "A newly composed invitation",
		primitives: [{ kind: "attempt", rootActionId: "greet" }],
	};
}
