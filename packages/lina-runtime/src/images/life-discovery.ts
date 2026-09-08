import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { VisualPurpose } from "../../../lina-core/src/agents/visual.ts";
import {
	discoverEventImageCandidates,
	type ImageDiscoveryStatus,
} from "../../../lina-core/src/world/image-discovery.ts";
import { imageIntentId } from "../../../lina-core/src/world/image-intents.ts";
import {
	avatarPeriodicSource,
	resolveAvatarPolicy,
} from "../../../lina-core/src/world/image-policy.ts";
import type {
	LifeImageIntent,
	LifeImageSource,
} from "../../../lina-core/src/world/image-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";

export interface LifeImageDiscoveryCandidate {
	intentId: string;
	source: LifeImageSource | null;
	agentId: string;
	visualAgentIds: string[];
	reason: string;
}
export interface LifeImageVisit {
	status: Extract<
		ImageDiscoveryStatus,
		"not_configured" | "hold" | "ready" | "quiet"
	>;
	candidates: LifeImageDiscoveryCandidate[];
	dueAtMs: number | null;
	maxJobsPerVisit: number;
}

/** Read planning is side-effect free; `freeze` is the only discovery write. */
export class LifeImageDiscovery {
	constructor(
		private readonly world: WorldStore,
		private readonly agents: AgentStore,
	) {}
	preview(worldId: string, nowMs: number): LifeImageVisit {
		const settings = this.world.imageSettings(worldId);
		if (!settings)
			return {
				status: "not_configured",
				candidates: [],
				dueAtMs: null,
				maxJobsPerVisit: 0,
			};
		const config = this.world.lifeConfig(worldId);
		const intents = this.world.imageIntents(worldId);
		const candidates: LifeImageDiscoveryCandidate[] = [];
		let dueAtMs: number | null = null;
		if (config.images?.mode === "automatic") {
			const event = discoverEventImageCandidates({
				settings,
				posts: this.world.imageDiscoveryPosts(worldId),
				acceptedSteps: this.world.imageDiscoveryAcceptedSteps(worldId),
				existingIntents: intents,
			});
			for (const candidate of event.candidates)
				candidates.push({
					intentId: candidate.intentId,
					source: candidate.source,
					agentId: candidate.agentId,
					visualAgentIds: candidate.visualAgentIds,
					reason: candidate.reason,
				});
		}
		if (config.avatars?.mode === "automatic" && config.usage) {
			let lifeRevision: number | null = null;
			const active = this.world.activePublicationAgents(worldId);
			for (const agentId of this.world.activePublicationAgents(worldId)) {
				if (!this.agents.get(agentId)) continue;
				const visual = this.agents.visual(agentId);
				const policy = visual.avatarPolicy;
				if (!policy || policy.worldId !== worldId) continue;
				if (visual.pinned && policy.whilePinned === "skip") continue;
				const resolved = resolveAvatarPolicy({
					worldId,
					agentId,
					avatarPolicyRevision: visual.avatarPolicyRevision,
					policy,
					config,
					settings,
				});
				if (policy.schedule?.kind === "wall" && nowMs < policy.schedule.epochMs)
					dueAtMs =
						dueAtMs === null
							? policy.schedule.epochMs
							: Math.min(dueAtMs, policy.schedule.epochMs);
				if (policy.schedule?.kind !== "wall" && lifeRevision === null) {
					if (!this.world.isLifePrepared(worldId)) continue;
					lifeRevision = this.world.lifeSnapshot(worldId).revision;
				}
				const source = avatarPeriodicSource(resolved, nowMs, lifeRevision ?? 0);
				if (!source) continue;
				if (source.kind === "avatar_wall") {
					const intervalMs = resolved.avatars.intervalMs;
					if (intervalMs === null)
						throw Error("Wall avatar interval is missing");
					const nextDue = source.dueAtMs + intervalMs;
					dueAtMs = dueAtMs === null ? nextDue : Math.min(dueAtMs, nextDue);
				}
				const intentId = imageIntentId({
					worldId,
					agentId,
					source,
					requestKey: null,
				});
				if (intents.some((intent) => intent.intentId === intentId)) continue;
				candidates.push({
					intentId,
					source,
					agentId,
					visualAgentIds: [agentId],
					reason: "periodic_avatar_due",
				});
			}
			for (const step of this.world.imageDiscoveryAcceptedSteps(worldId)) {
				const receipt = step.receipt;
				if (
					!receipt ||
					step.decision.kind !== "event" ||
					!step.decision.familyId
				)
					continue;
				for (const agentId of active) {
					if (!this.agents.get(agentId)) continue;
					const visual = this.agents.visual(agentId);
					const policy = visual.avatarPolicy;
					if (
						!policy ||
						policy.worldId !== worldId ||
						(visual.pinned && policy.whilePinned === "skip") ||
						!policy.eventFamilyIds.includes(step.decision.familyId) ||
						!settings.avatarEventRules.some(
							(rule) =>
								rule.familyId === step.decision.familyId &&
								rule.agentIds.includes(agentId),
						)
					)
						continue;
					const resolved = resolveAvatarPolicy({
						worldId,
						agentId,
						avatarPolicyRevision: visual.avatarPolicyRevision,
						policy,
						config,
						settings,
					});
					const source = {
						kind: "avatar_event" as const,
						resolvedPolicyId: resolved.id,
						eventId: receipt.eventId,
						worldRevision: receipt.worldRevision,
						lifeRevision: receipt.lifeRevision,
						familyId: step.decision.familyId,
						stepId: step.id,
						triggerSettingsRevision: settings.revision,
						triggerDigest: lifeDigest({
							worldId,
							agentId,
							familyId: step.decision.familyId,
							settingsRevision: settings.revision,
						}),
					};
					const intentId = imageIntentId({
						worldId,
						agentId,
						source,
						requestKey: null,
					});
					if (intents.some((intent) => intent.intentId === intentId)) continue;
					candidates.push({
						intentId,
						source,
						agentId,
						visualAgentIds: [agentId],
						reason: "accepted_avatar_event",
					});
				}
			}
		}
		return {
			status: candidates.length ? "ready" : "hold",
			candidates,
			dueAtMs,
			maxJobsPerVisit: settings.maxJobsPerVisit,
		};
	}
	freeze(
		worldId: string,
		candidate: LifeImageDiscoveryCandidate,
	): LifeImageIntent {
		if (candidate.source === null)
			throw Error("Discovery candidate has no frozen source");
		if (candidate.source.kind !== "event_post") {
			const visual = this.agents.visual(candidate.agentId);
			const policy = visual.avatarPolicy;
			if (!policy || policy.worldId !== worldId)
				throw Error("Avatar policy is no longer configured");
			this.world.resolveImageAvatarPolicy(
				worldId,
				candidate.agentId,
				visual.avatarPolicyRevision,
				policy,
			);
		}
		const purpose: VisualPurpose =
			candidate.source.kind === "event_post"
				? { kind: "life", worldId, recipientId: candidate.source.recipientId }
				: { kind: "avatar" };
		const visuals = candidate.visualAgentIds.map((agentId) =>
			this.agents.freezeVisualIdentity(agentId, purpose),
		);
		if (!visuals.length)
			throw Error("Discovery candidate has no approved visual identities");
		return this.world.freezeImageIntent({
			worldId,
			agentId: candidate.agentId,
			source: candidate.source,
			visuals,
			requestKey: null,
		});
	}
}
