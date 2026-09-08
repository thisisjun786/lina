import type { WorldPack } from "../src/world/authoring-types.ts";
import type {
	SocialPrepareRequestV1,
	WorldSocialPort,
} from "../src/world/social-store-types.ts";
import type { WorldStore } from "../src/world/store.ts";
import { identityPolicy } from "./life-fixture.ts";
import { socialIntent, socialPack } from "./life-social-pack-fixture.ts";

export function activateSocialPack(
	store: WorldStore,
	pack: WorldPack = socialPack(),
) {
	const draft = store.draftWorld({
		worldId: pack.worldId,
		authoredText: pack.background.authoredText,
	});
	const edited = store.editWorldDraft(draft.id, draft.revision, {
		authoredText: draft.authoredText,
		pack,
	});
	const options = {
		expectedWorldRevision: null,
		simulationTime: 0,
		agentId: "lina",
		targetAgentId: null,
		seed: "synthetic",
		limits: {
			maxChars: 2000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 1000,
		},
		relocations: [],
	};
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	if (!preview.packDigest) throw Error("Missing synthetic pack digest");
	store.activateWorldDraft({
		draftId: edited.id,
		expectedRevision: edited.revision,
		idempotencyKey: "activate",
		packDigest: preview.packDigest,
		previewDigest: preview.digest,
		options,
	});
	return store as WorldStore & WorldSocialPort;
}

export function socialRequest(
	patch: Partial<SocialPrepareRequestV1> = {},
): SocialPrepareRequestV1 {
	return {
		version: 1,
		worldId: "test-world",
		requestId: "request-1",
		intent: socialIntent(),
		targetResponse: {
			intentId: "intent-1",
			agentId: "mira",
			decision: "accept",
		},
		identity: identityPolicy(),
		simulationTime: 1,
		limits: {
			maxOperations: 10000,
			maxBindings: 1000,
			maxDepth: 16,
			maxBytes: 500000,
			maxHistoryEntries: 1000,
			maxTraceEntries: 1000,
		},
		...patch,
	};
}
