import type { BotBinding } from "../protocol.ts";
import type { AgentProfile } from "./types.ts";

export type VisualPurpose =
	| { kind: "avatar" }
	| { kind: "life"; worldId: string; recipientId: string };
export type AvatarPolicy = {
	worldId: string;
	applyMode: "manual" | "automatic";
	whilePinned: "skip" | "candidate";
	schedule:
		| null
		| { kind: "wall"; epochMs: number }
		| { kind: "steps"; epochRevision: number; intervalSteps: number };
	eventFamilyIds: string[];
};
export type VisualReference = {
	version: 1;
	id: string;
	agentId: string;
	assetId: string;
	sha256: string;
	mime: "image/png" | "image/jpeg";
	size: number;
	origin:
		| { kind: "upload" }
		| { kind: "avatar"; avatarId: string }
		| { kind: "attachment"; binding: BotBinding; artifactId: string };
};
export type VisualGrant = {
	version: 1;
	id: string;
	agentId: string;
	revision: number;
	subject:
		| { kind: "reference"; referenceId: string; sha256: string }
		| { kind: "text_identity"; identityDigest: string };
	providerUse: boolean;
	purposes: VisualPurpose[];
	revoked: boolean;
};
export type VisualGrantRef = {
	grantId: string;
	revision: number;
	purpose: VisualPurpose;
};
export type VisualInput = {
	anchors: string[];
	canonicalReferenceId: string | null;
	textIdentity: string | null;
	avatarPolicy: AvatarPolicy | null;
	referenceLimits: { maxAssets: number; maxTotalBytes: number } | null;
	maxHistoryRecords: number | null;
};
export type AgentVisual = VisualInput & {
	version: 1;
	agentId: string;
	revision: number;
	profileRevision: number;
	avatarPolicyRevision: number;
	pinned: boolean;
};
export type FrozenVisualIdentity = {
	agentId: string;
	profileRevision: number;
	visualRevision: number;
	avatarPolicyRevision: number;
	anchors: string[];
	textIdentity: string | null;
	reference: VisualReference | null;
	grants: VisualGrantRef[];
};
/** Pure historical proof. The world owner validates the referenced original records. */
export type AvatarSourceProof =
	| {
			kind: "avatar_wall";
			scheduleKey: string;
			slotIndex: number;
			dueAtMs: number;
			resolvedPolicyId: string;
	  }
	| {
			kind: "avatar_steps";
			scheduleKey: string;
			slotIndex: number;
			dueLifeRevision: number;
			resolvedPolicyId: string;
	  }
	| {
			kind: "avatar_event";
			resolvedPolicyId: string;
			eventId: string;
			worldRevision: number;
			lifeRevision: number;
			familyId: string;
			stepId: string;
			triggerSettingsRevision: number;
			triggerDigest: string;
	  };
export type AvatarAdmission = {
	agentId: string;
	worldId: string;
	intentId: string;
	materialDigest: string;
	resolvedPolicyId: string;
	profileRevision: number;
	visualRevision: number;
	avatarPolicyRevision: number;
	source: AvatarSourceProof;
	grants: VisualGrantRef[];
};
export type AvatarAsset = {
	sha256: string;
	mime: "image/png" | "image/jpeg";
	size: number;
};
/** Minimal generated result crossing runtime -> AgentStore; contains no world/runtime imports. */
export type GeneratedAvatarCandidate = AvatarAdmission & {
	version: 1;
	kind: "generated";
	candidateId: string;
	attemptId: string;
	providerGenerationId: string;
	artifact: AvatarAsset & { id: string };
	avatar: AvatarAsset;
};
export type AvatarApplyInput = {
	requestKey: string;
	candidateId: string;
	expectedProfileRevision: number;
	expectedVisualRevision: number;
	mode: "automatic" | "manual" | "restore";
};
export type AvatarApplicationReceipt = {
	version: 1;
	agentId: string;
	requestKey: string;
	payloadDigest: string;
	candidateId: string;
	mode: AvatarApplyInput["mode"];
	avatarId: string;
	profile: AgentProfile;
	visual: AgentVisual;
};
/** Never deserialize this capability from HTTP. Runtime composes current world/work and byte checks. */
export type AvatarApplicationAuthority = {
	kind: "owner" | "automatic";
	validateCandidate: (
		candidate: GeneratedAvatarCandidate,
		mode: AvatarApplyInput["mode"],
	) => boolean;
};
export type ManualAvatarInput = {
	requestKey: string;
	expectedProfileRevision: number;
	expectedVisualRevision: number;
	asset: AvatarAsset;
	source: { kind: "upload" } | { kind: "restore"; authorityId: string };
};
export type AvatarAuthority =
	| {
			version: 1;
			id: string;
			agentId: string;
			sha256: string;
			kind: "generated";
			requestKey: string;
			candidate: GeneratedAvatarCandidate;
	  }
	| {
			version: 1;
			id: string;
			agentId: string;
			sha256: string;
			kind: "manual";
			requestKey: string;
			source: ManualAvatarInput["source"];
			asset: AvatarAsset;
	  }
	| {
			version: 1;
			id: string;
			agentId: string;
			sha256: string;
			kind: "legacy";
			source:
				| { kind: "profile"; profileRevision: number }
				| { kind: "seed"; sourceId: string };
			asset: AvatarAsset;
	  };
export type ManualAvatarReceipt = {
	version: 1;
	agentId: string;
	requestKey: string;
	payloadDigest: string;
	authorityId: string;
	profile: AgentProfile;
	visual: AgentVisual;
};
/** Inventory accounts for physical files (including orphans), never permission. */
export type AvatarInventoryFile = AvatarAsset & { fileId: string };
export type AvatarCapacityInput = {
	reservationId: string;
	owner:
		| {
				kind: "generated";
				agentId: string;
				worldId: string;
				intentId: string;
				attemptId: string;
		  }
		| { kind: "manual"; agentId: string; requestKey: string };
	maxBytes: number;
};
export type AvatarCapacityReceipt = AvatarCapacityInput & {
	version: 1;
	state: "reserved" | "settled" | "released";
	asset: AvatarInventoryFile | null;
};
export type AvatarCapacityUsage = {
	files: number;
	bytes: number;
	reservedFiles: number;
	reservedBytes: number;
};
