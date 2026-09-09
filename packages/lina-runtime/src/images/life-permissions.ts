import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";

export interface LifeImageAuthorityServices {
	world: WorldStore;
	agents: AgentStore;
	/** The installation's actual TaskManager source guard; this callback must not start execution. */
	assertWorkCurrent(worldId: string): void;
}

/** Historical ownership crosses two independent databases; today's grants cannot repair a forged origin. */
export function assertLifeImageHistory(
	services: LifeImageAuthorityServices,
	worldId: string,
	intentId: string,
) {
	const intent = services.world.imageIntent(worldId, intentId);
	if (!intent) throw Error("Missing original LIFE image intent");
	for (const frozen of intent.material.visuals)
		services.agents.validateFrozenVisualIdentity(frozen);
	if (intent.source.kind !== "event_post") {
		const policy = services.world.imageAvatarPolicy(
			worldId,
			intent.source.resolvedPolicyId,
		);
		const frozen = intent.material.visuals[0];
		const visual = frozen
			? services.agents.visualAt(frozen.agentId, frozen.visualRevision)
			: undefined;
		if (
			!frozen ||
			!visual ||
			!visual.avatarPolicy ||
			frozen.agentId !== intent.owner.agentId ||
			policy.avatarPolicyRevision !== frozen.avatarPolicyRevision ||
			lifeDigest(policy.policy) !== lifeDigest(visual.avatarPolicy)
		)
			throw Error(
				"Image avatar policy differs from original AgentStore history",
			);
	}
	return intent;
}

/** Storage-only permission check. Budget, lease and destination CAS are additional effect guards. */
export function assertLifeImageAuthority(
	services: LifeImageAuthorityServices,
	worldId: string,
	intentId: string,
	phase: "provider" | "destination",
) {
	const intent = assertLifeImageHistory(services, worldId, intentId);
	services.assertWorkCurrent(worldId);
	if (!services.world.imageIntentAllowed(worldId, intentId, phase))
		throw Error("Image source is no longer permitted");
	for (const frozen of intent.material.visuals) {
		if (!services.agents.visualIdentityAllowed(frozen, phase))
			throw Error("Image visual purpose is no longer permitted");
		if (phase === "provider") {
			const current = services.agents.visual(frozen.agentId),
				profile = services.agents.get(frozen.agentId);
			if (
				!profile ||
				profile.revision !== frozen.profileRevision ||
				current.revision !== frozen.visualRevision
			)
				throw Error("Image visual identity changed before generation");
		}
	}
	return intent;
}
