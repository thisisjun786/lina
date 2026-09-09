import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	identityPolicy,
	lifeDefinition,
	socialCommit,
} from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

export function publicationStoreFixture(
	path = ":memory:",
	eventSummary?: string,
	allowScene = false,
) {
	const store = new WorldStore(path, () => 1000);
	store.create(worldDefinition());
	const def = lifeDefinition();
	def.projection.disclosures = [
		{
			subject: { kind: "world_event", id: "test-world:1" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "friends" }],
				publication: ["friends"],
			},
		},
	];
	if (allowScene)
		def.projection.disclosures.push({
			subject: { kind: "world_scene", id: "meeting" },
			policy: {
				knowers: ["lina", "mira"],
				disclosures: [{ agentId: "lina", recipientId: "friends" }],
				publication: ["friends"],
			},
		});
	store.prepareLife(def);
	const payload = {
		kind: "publication_candidate" as const,
		eventId: "test-world:1",
	};
	const commit = socialCommit();
	if (eventSummary !== undefined && commit.world.kind === "activity")
		commit.world.summary = eventSummary;
	store.acceptLife(
		{
			...commit,
			effects: [
				{
					version: 1,
					worldId: "test-world",
					id: "intent",
					lifeRevision: 1,
					payload,
					payloadDigest: lifeDigest(payload),
				},
			],
		},
		identityPolicy(),
	);
	const {
		worldId: _w,
		revision: _r,
		...config
	} = store.lifeConfig("test-world");
	store.setLifeConfig("test-world", 0, {
		...config,
		run: { mode: "manual" },
		publication: { mode: "automatic", recipientIds: ["friends"] },
		models: {
			director: null,
			actor: { provider: "synthetic", model: "narrator" },
		},
		usage: {
			windowMs: 1000,
			maxInputTokens: 1000,
			maxOutputTokens: 1000,
			maxImages: 0,
		},
		limits: {
			maxActorActions: 0,
			maxCausalDepth: 0,
			maxModelCalls: 1,
			evaluation: {
				maxDepth: 10,
				maxOperations: 100,
				maxChars: 20000,
				maxRecords: 100,
			},
		},
	});
	store.setPublicationSettings("test-world", 0, {
		version: 1,
		agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
		reactionIds: [],
		maxChainDepth: 3,
		maxActionsPerChain: 10,
		perAuthorCooldownSteps: 0,
		maxJobsPerRun: 1,
	});
	return store;
}
