import type {
	LifeConfigInput,
	WorldPack,
	WorldPreviewOptions,
} from "../../lina-core/src/world/authoring-types.ts";
import { lifeDefinition } from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";

export function authorPack(worldId = "test-world"): WorldPack {
	return {
		schemaVersion: 1,
		worldId,
		version: 1,
		background: {
			authoredText: "An island in an unspecified era",
			era: null,
			environment: "island",
			description: null,
		},
		world: worldDefinition(worldId),
		life: lifeDefinition(worldId),
		constraints: [],
		roles: ["lina", "mira", "sol"].map((agentId) => ({
			agentId,
			roleId: agentId,
			description: "An authored role",
			status: "active",
		})),
		variables: [],
		predicates: [],
		lore: [],
		rules: [],
		eventFamilies: [],
		unresolved: [],
		importReport: [],
	};
}
export const emptyLifeConfig: LifeConfigInput = {
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
export const authorPreview: WorldPreviewOptions = {
	expectedWorldRevision: null,
	simulationTime: 0,
	agentId: "lina",
	targetAgentId: null,
	seed: "synthetic-preview",
	limits: { maxChars: 12000, maxRecords: 30, maxDepth: 4, maxOperations: 1000 },
	relocations: [],
};
