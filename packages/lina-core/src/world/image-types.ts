import type {
	AvatarPolicy,
	AvatarSourceProof,
	FrozenVisualIdentity,
	VisualPurpose,
} from "../agents/visual.ts";
import type { BotBinding } from "../protocol.ts";
import type { LifeConfig } from "./authoring-types.ts";

/** Generation and artifact identity stay inside one explicit storage owner. */
export type ImageOwner =
	| { kind: "conversation"; binding: BotBinding }
	| { kind: "life"; worldId: string; agentId: string };

export interface LifeImageSettingsInput {
	version: 1;
	worldVersion: number | null;
	route: { provider: string; model: string };
	eventRules: Array<{
		familyId: string;
		agentIds: string[];
		trigger: "event" | "scene_change";
		composition: "single_subject" | "all_scene_subjects";
	}>;
	avatarEventRules: Array<{ familyId: string; agentIds: string[] }>;
	perAuthorCooldownSteps: number;
	attachMode: "manual" | "automatic";
	maxJobsPerVisit: number;
	storage: {
		maxActiveJobs: number;
		maxArchivedJobs: number;
		maxAssets: number;
		maxTotalBytes: number;
	};
}

export type LifeImageSettings = LifeImageSettingsInput & {
	worldId: string;
	revision: number;
};

export interface EventImageSource {
	kind: "event_post";
	publicationId: string;
	postRevision: number;
	eventId: string;
	worldRevision: number;
	lifeRevision: number;
	publicationMaterialId: string;
	publicationMaterialDigest: string;
	recipientId: string;
}

/** Trusted image input assembled only from an actually published, currently permitted post. */
export interface PublishedImageMaterial {
	version: 1;
	worldId: string;
	authorAgentId: string;
	source: EventImageSource;
	claims: Array<{
		kind: "world_event" | "world_fact" | "life_claim";
		text: string;
	}>;
	scene: import("./types.ts").WorldContext["scene"];
	/** Excludes post/event/scene IDs and clock values; used only with explicit cooldown policy. */
	fingerprint: string;
	digest: string;
}

export type LifeImageSource = EventImageSource | AvatarSourceProof;

export interface ResolvedAvatarPolicy {
	version: 1;
	id: string;
	digest: string;
	worldId: string;
	agentId: string;
	avatarPolicyRevision: number;
	policy: AvatarPolicy;
	configRevision: number;
	avatars: NonNullable<LifeConfig["avatars"]>;
	usage: NonNullable<LifeConfig["usage"]>;
	imageSettingsRevision: number;
	worldVersion: number | null;
	scheduleKey: string | null;
}

export interface LifeImageMaterial {
	version: 1;
	purpose: VisualPurpose;
	publication: PublishedImageMaterial | null;
	visuals: FrozenVisualIdentity[];
	prompt: string;
	altText: string;
	fingerprint: string;
	digest: string;
}

export interface LifeImageIntent {
	version: 2;
	intentId: string;
	owner: Extract<ImageOwner, { kind: "life" }>;
	source: LifeImageSource;
	material: LifeImageMaterial;
	settingsRevision: number;
	configRevision: number;
	createdAtMs: number;
	createdLifeRevision: number;
	/** Explicit owner requests have separate stable operation identities. */
	requestKey: string | null;
	briefDigest: string;
}
