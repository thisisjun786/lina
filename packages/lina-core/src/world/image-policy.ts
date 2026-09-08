import type { AvatarPolicy, AvatarSourceProof } from "../agents/visual.ts";
import {
	parseAvatarPolicy,
	parseAvatarSource,
} from "../agents/visual-validation.ts";
import type { LifeConfig } from "./authoring-types.ts";
import { parseLifeConfigInput } from "./authoring-validation.ts";
import type { LifeImageSettings, ResolvedAvatarPolicy } from "./image-types.ts";
import { parseLifeImageSettings } from "./image-validation.ts";
import { identifier, lifeDigest, revision } from "./life-json.ts";

export function resolveAvatarPolicy(input: {
	worldId: string;
	agentId: string;
	avatarPolicyRevision: number;
	policy: AvatarPolicy;
	config: LifeConfig;
	settings: LifeImageSettings;
}): ResolvedAvatarPolicy {
	const worldId = identifier(input.worldId),
		agentId = identifier(input.agentId);
	const policy = parseAvatarPolicy(input.policy);
	const {
		worldId: configWorld,
		revision: configRevision,
		...configInput
	} = input.config;
	const config = parseLifeConfigInput(configInput);
	const {
		worldId: settingsWorld,
		revision: imageSettingsRevision,
		...settingsInput
	} = input.settings;
	const settings = parseLifeImageSettings(settingsInput);
	if (
		policy.worldId !== worldId ||
		configWorld !== worldId ||
		settingsWorld !== worldId
	)
		throw Error("Avatar policy world mismatch");
	if (!config.avatars || !config.usage)
		throw Error("Avatar generation is not configured");
	let scheduleKey: string | null = null;
	const schedule = policy.schedule;
	if (schedule) {
		if (schedule.kind === "wall" && config.avatars.intervalMs === null)
			throw Error("Wall avatar cadence requires an explicit interval");
		if (schedule.kind === "steps" && config.avatars.intervalMs !== null)
			throw Error("Avatar cadence is ambiguous between steps and wall time");
		const cadence =
			schedule.kind === "wall"
				? {
						kind: "wall",
						epoch: schedule.epochMs,
						interval: config.avatars.intervalMs,
					}
				: {
						kind: "steps",
						epoch: schedule.epochRevision,
						interval: schedule.intervalSteps,
					};
		// Deliberately exclude every policy/config/visual revision and all non-cadence choices.
		scheduleKey = lifeDigest({ worldId, agentId, ...cadence });
	}
	const body = {
		version: 1 as const,
		worldId,
		agentId,
		avatarPolicyRevision: revision(input.avatarPolicyRevision, 1),
		policy,
		configRevision: revision(configRevision),
		avatars: config.avatars,
		usage: config.usage,
		imageSettingsRevision: revision(imageSettingsRevision, 1),
		worldVersion: settings.worldVersion,
		scheduleKey,
	};
	const digest = lifeDigest(body);
	return { ...body, id: `avatar-policy-${digest}`, digest };
}

export function avatarPeriodicSource(
	policy: ResolvedAvatarPolicy,
	nowMs: number,
	lifeRevision: number,
): AvatarSourceProof | null {
	revision(nowMs);
	revision(lifeRevision);
	const schedule = policy.policy.schedule;
	if (!schedule || !policy.scheduleKey) return null;
	const clock = schedule.kind === "wall" ? nowMs : lifeRevision;
	const epoch =
		schedule.kind === "wall" ? schedule.epochMs : schedule.epochRevision;
	const interval =
		schedule.kind === "wall"
			? policy.avatars.intervalMs
			: schedule.intervalSteps;
	if (interval === null) throw Error("Missing resolved avatar interval");
	revision(interval, 1);
	revision(epoch);
	if (clock < epoch) return null;
	const slotIndex = revision(Math.floor((clock - epoch) / interval));
	const due = revision(epoch + slotIndex * interval);
	const common = {
		scheduleKey: policy.scheduleKey,
		slotIndex,
		resolvedPolicyId: policy.id,
	};
	return schedule.kind === "wall"
		? { kind: "avatar_wall", ...common, dueAtMs: due }
		: { kind: "avatar_steps", ...common, dueLifeRevision: due };
}

/** Original provenance stays on the source, while a non-cadence edit cannot reroll the same intent. */
export function avatarIntentId(
	worldId: string,
	agentId: string,
	source: AvatarSourceProof,
): string {
	identifier(worldId);
	identifier(agentId);
	const parsed = parseAvatarSource(source);
	const key =
		parsed.kind === "avatar_event"
			? { kind: "avatar_event", worldId, agentId, eventId: parsed.eventId }
			: {
					kind: "avatar_periodic",
					worldId,
					agentId,
					scheduleKey: parsed.scheduleKey,
					slotIndex: parsed.slotIndex,
				};
	return `life-image-${lifeDigest(key)}`;
}
