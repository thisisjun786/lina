import { dirname, join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import {
	imageAvatarPolicy,
	imageStoreFixture,
} from "../../lina-core/test/life-image-store-fixture.ts";

export function lifeImagePermissionsFixture() {
	const f = imageStoreFixture(),
		agents = new AgentStore(join(dirname(f.path), "agents.sqlite"));
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "Private biography",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const visual = agents.updateVisual("lina", 1, {
		anchors: ["blue hair"],
		textIdentity: "Approved identity",
		canonicalReferenceId: null,
		avatarPolicy: imageAvatarPolicy,
		referenceLimits: { maxAssets: 3, maxTotalBytes: 100000 },
		maxHistoryRecords: 100,
	});
	const grant = agents.putVisualGrant("lina", visual.revision, {
		version: 1,
		id: "grant",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(visual),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" }],
		revoked: false,
	});
	const frozen = agents.freezeVisualIdentity("lina", { kind: "avatar" });
	const policy = f.store.resolveImageAvatarPolicy(
		"test-world",
		"lina",
		visual.avatarPolicyRevision,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		f.store.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing avatar source");
	const input = {
		worldId: "test-world",
		agentId: "lina",
		source,
		visuals: [frozen],
		requestKey: null,
	};
	const intent = f.store.freezeImageIntent(input);
	let workCurrent = true,
		checked = 0;
	const services = {
		world: f.store,
		agents,
		assertWorkCurrent: () => {
			checked++;
			if (!workCurrent) throw Error("Task source changed");
		},
	};
	return {
		...f,
		agents,
		grant,
		visual,
		input,
		intent,
		services,
		checks: () => checked,
		revokeWork: () => {
			workCurrent = false;
		},
		close: () => {
			agents.close();
			f.close();
		},
	};
}
