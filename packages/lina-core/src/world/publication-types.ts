/** Publication mode, audience and model/token budgets remain owned by LifeConfig. */
export interface PublicationSettingsV1 {
	version: 1;
	agentRecipients: Array<{ agentId: string; recipientId: string }>;
	reactionIds: string[];
	maxChainDepth: number;
	maxActionsPerChain: number;
	perAuthorCooldownSteps: number;
	maxJobsPerRun: number;
}
export interface PublicationEventRule {
	familyId: string;
	authorAgentIds: string[];
	recipientIds: string[];
	/** Owner-authored public description; never an actor's unrestricted event summary. */
	summary: string;
}
export type PublicationSettingsInput =
	| PublicationSettingsV1
	| (Omit<PublicationSettingsV1, "version"> & {
			version: 2;
			worldVersion: number;
			eventRules: PublicationEventRule[];
	  });
export type PublicationSettings = PublicationSettingsInput & {
	worldId: string;
	revision: number;
};
export type PublicationPrincipal =
	| { kind: "viewer"; grantId: string }
	| { kind: "agent"; agentId: string };

/** Claim text is supplied by the permitted material, never by the narrator. */
export type PublicationSegment =
	| { kind: "claim"; claimId: string }
	| { kind: "imaginative"; text: string };
export type PublicationDecision =
	| { kind: "no_post" | "no_reply" }
	| { kind: "post"; segments: PublicationSegment[] };

/** Internal frozen authority and material; never serialize this envelope to a viewer or model. */
export interface EventPublicationMaterial {
	version: 1;
	id: string;
	worldId: string;
	authorAgentId: string;
	source: {
		kind: "event";
		intentId: string;
		eventId: string;
		worldRevision: number;
		lifeRevision: number;
	};
	definitionRevision: number;
	policyRevision: number;
	workRevision: number;
	workAncestryRevision: number;
	limits: import("./life-types.ts").LifeViewLimits;
	configRevision: number;
	settingsRevision: number;
	workEvidenceDigest: string;
	audience: string[];
	allowedClaims: Array<{
		id: string;
		kind: "world_event" | "world_fact" | "life_claim";
		sourceId: string;
		text: string;
	}>;
	permittedScene: import("./life-types.ts").PublicationView["scene"];
	digest: string;
}

export interface PublicationAuthorV1 {
	agentId: string;
	name: string;
	voice: string;
	profileRevision: number;
	behavior: Pick<
		import("./life-types.ts").SharedPersonaView,
		"traits" | "habits" | "attitudes"
	>;
}
export type PublicationAuthor =
	| PublicationAuthorV1
	| (PublicationAuthorV1 & {
			version: 2;
			sourceStamp:
				| import("../agents/behavior-types.ts").BehaviorSourceStamp
				| null;
	  });
export type PublicationJobStatus =
	| "pending"
	| "prepared"
	| "ready"
	| "published"
	| "skipped"
	| "withheld"
	| "failed"
	| "unknown";
export interface EventPublicationJob {
	version: 1;
	id: string;
	worldId: string;
	revision: number;
	intentId: string;
	authorAgentId: string;
	recipientId: string;
	attempt: number;
	attemptId: string;
	status: PublicationJobStatus;
	material: EventPublicationMaterial | null;
	author: PublicationAuthor | null;
	modelSettingsRevision: number | null;
	decision: PublicationDecision | null;
	postId: string | null;
	error: string | null;
}

export interface PublicationRunInput {
	requestKey: string;
	expectedConfigRevision: number;
	expectedSettingsRevision: number;
	mode: "manual" | "automatic";
}
export interface PublicationRun {
	version: 1;
	worldId: string;
	id: string;
	revision: number;
	input: PublicationRunInput;
	batch: Array<{ jobId: string; attemptId: string }>;
	nextIndex: number;
	outcomes: Array<"published" | "skipped" | "withheld" | "failed">;
	status: "running" | "completed" | "blocked";
	blocked: string | null;
	lease: import("./autonomy-types.ts").LifeLease | null;
	leaseRevision: number;
}

export type PublicationRenderedSegment =
	| {
			kind: "claim";
			claimKind: "world_event" | "world_fact" | "life_claim";
			text: string;
	  }
	| { kind: "imaginative"; text: string };
/** Internal stored post; feed uses the explicit PublicLifePost projection. */
export interface EventPublicationPost {
	version: 1;
	worldId: string;
	id: string;
	revision: number;
	jobId: string;
	attemptId: string;
	material: EventPublicationMaterial;
	author: PublicationAuthor;
	roots: Array<{ rootId: string; depth: number }>;
	segments: PublicationRenderedSegment[];
	createdAt: number;
	createdLifeRevision: number;
	withdrawn: boolean;
}
export interface PublicLifePost {
	id: string;
	revision: number;
	kind: "post" | "reply" | "reshare";
	author:
		| { kind: "agent"; agentId: string; name: string | null }
		| { kind: "viewer" };
	parentPostId?: string;
	segments: Array<
		PublicationRenderedSegment | { kind: "user_authored"; text: string }
	>;
	createdAt: number;
}

/** Current reader state for one configured reaction; no other principal or count. */
export interface PublicLifeReactionState {
	reactionId: string;
	active: boolean;
}
/** Mutable reader projection. Frozen reply material continues to use PublicLifePost. */
export interface PublicLifePostView extends PublicLifePost {
	reactions: PublicLifeReactionState[];
	/** Trusted runtime supplies this current permission/byte-verified projection. Never frozen into reply material. */
	image?: PublicLifeImage;
}

export interface PublicLifeImage {
	artifactId: string;
	attachmentVersion: number;
	mime: "image/png" | "image/jpeg";
	size: number;
	altText: string;
	url: string;
}

/** Real inherited event provenance is distinct from the reply snapshot and job key. */
export type ReplyMaterialSource = {
	kind: "reply";
	parentPostId: string;
	parentPostRevision: number;
	parentOwner: "post" | "reply";
	worldRevision: number;
	lifeRevision: number;
	origin: EventPublicationMaterial["source"];
};
export type ReplyPublicationMaterial = Omit<
	EventPublicationMaterial,
	"version" | "source"
> & {
	version: 2;
	source: ReplyMaterialSource;
	parent: PublicLifePost;
	authority: import("./publication-input.ts").PublicationAuthority;
	parentRoots: import("./publication-chains.ts").PublicationChainRef[];
};
export type ReplyPublicationJob = Omit<
	EventPublicationJob,
	"version" | "intentId" | "material"
> & {
	version: 2;
	source: { kind: "reply"; parentPostId: string };
	material: ReplyPublicationMaterial | null;
};
export type ReplyPublicationPost = Omit<
	EventPublicationPost,
	"version" | "material"
> & {
	version: 2;
	material: ReplyPublicationMaterial;
};
export type PublicationMaterial =
	| EventPublicationMaterial
	| ReplyPublicationMaterial;
export type PublicationJob = EventPublicationJob | ReplyPublicationJob;
export type PublicationPost = EventPublicationPost | ReplyPublicationPost;
