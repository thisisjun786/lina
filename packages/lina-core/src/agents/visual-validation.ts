import { createHash } from "node:crypto";
import type { BotBinding } from "../protocol.ts";
import { boundedId, boundedList, boundedText } from "./validation.ts";
import type {
	AgentVisual,
	AvatarAdmission,
	AvatarApplyInput,
	AvatarAsset,
	AvatarPolicy,
	AvatarSourceProof,
	GeneratedAvatarCandidate,
	VisualGrant,
	VisualGrantRef,
	VisualInput,
	VisualPurpose,
	VisualReference,
} from "./visual.ts";

export const MAX_AVATAR_FILES = 128;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_TOTAL_BYTES = MAX_AVATAR_FILES * MAX_AVATAR_BYTES;
/** Canonical recursive key ordering makes receipts independent of caller key order. */
export function visualDigest(value: unknown): string {
	const canonical = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canonical)
			: v !== null && typeof v === "object"
				? Object.fromEntries(
						Object.keys(v)
							.sort()
							.map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
					)
				: v;
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
export function exact(value: unknown, keys: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")
	)
		throw Error("invalid visual fields");
	return value as Record<string, unknown>;
}
export function integer(
	v: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
		throw Error("invalid visual integer");
	return v;
}
export function hash(v: unknown): string {
	if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
		throw Error("invalid visual hash");
	return v;
}
export function bool(v: unknown): boolean {
	if (typeof v !== "boolean") throw Error("invalid visual boolean");
	return v;
}
export function one(v: unknown): 1 {
	if (v !== 1) throw Error("invalid visual version");
	return 1;
}
export function parseVisualPurpose(value: unknown): VisualPurpose {
	const v = value as VisualPurpose;
	if (v?.kind === "avatar") {
		exact(value, "kind");
		return { kind: "avatar" };
	}
	const r = exact(value, "kind,worldId,recipientId");
	if (r["kind"] !== "life") throw Error("invalid visual purpose");
	return {
		kind: "life",
		worldId: boundedId(r["worldId"], "world id"),
		recipientId: boundedId(r["recipientId"], "recipient id"),
	};
}
export function parseAvatarPolicy(value: unknown): AvatarPolicy {
	const v = exact(
		value,
		"worldId,applyMode,whilePinned,schedule,eventFamilyIds",
	);
	if (v["applyMode"] !== "manual" && v["applyMode"] !== "automatic")
		throw Error("invalid avatar apply mode");
	if (v["whilePinned"] !== "skip" && v["whilePinned"] !== "candidate")
		throw Error("invalid avatar pin policy");
	let schedule: AvatarPolicy["schedule"] = null;
	if (v["schedule"] !== null) {
		const s = v["schedule"] as { kind?: unknown };
		if (s?.kind === "wall") {
			const x = exact(s, "kind,epochMs");
			schedule = { kind: "wall", epochMs: integer(x["epochMs"]) };
		} else {
			const x = exact(s, "kind,epochRevision,intervalSteps");
			if (x["kind"] !== "steps") throw Error("invalid avatar schedule");
			schedule = {
				kind: "steps",
				epochRevision: integer(x["epochRevision"]),
				intervalSteps: integer(x["intervalSteps"], 1),
			};
		}
	}
	return {
		worldId: boundedId(v["worldId"], "world id"),
		applyMode: v["applyMode"],
		whilePinned: v["whilePinned"],
		schedule,
		eventFamilyIds: boundedList(v["eventFamilyIds"], "event families"),
	};
}
export function parseVisualInput(value: unknown): VisualInput {
	const v = exact(
		value,
		"anchors,canonicalReferenceId,textIdentity,avatarPolicy,referenceLimits,maxHistoryRecords",
	);
	let referenceLimits: VisualInput["referenceLimits"] = null;
	if (v["referenceLimits"] !== null) {
		const r = exact(v["referenceLimits"], "maxAssets,maxTotalBytes");
		referenceLimits = {
			maxAssets: integer(r["maxAssets"]),
			maxTotalBytes: integer(r["maxTotalBytes"]),
		};
	}
	return {
		anchors: boundedList(v["anchors"], "visual anchors"),
		canonicalReferenceId:
			v["canonicalReferenceId"] === null
				? null
				: boundedId(v["canonicalReferenceId"], "canonical reference"),
		textIdentity:
			v["textIdentity"] === null
				? null
				: boundedText(v["textIdentity"], "visual identity", 3000),
		avatarPolicy:
			v["avatarPolicy"] === null ? null : parseAvatarPolicy(v["avatarPolicy"]),
		referenceLimits,
		maxHistoryRecords:
			v["maxHistoryRecords"] === null ? null : integer(v["maxHistoryRecords"]),
	};
}
export function parseAgentVisual(value: unknown): AgentVisual {
	const v = exact(
		value,
		"version,agentId,revision,profileRevision,avatarPolicyRevision,pinned,anchors,canonicalReferenceId,textIdentity,avatarPolicy,referenceLimits,maxHistoryRecords",
	);
	const {
		version,
		agentId,
		revision,
		profileRevision,
		avatarPolicyRevision,
		pinned,
		...input
	} = v;
	return {
		...parseVisualInput(input),
		version: one(version),
		agentId: boundedId(agentId, "agent id"),
		revision: integer(revision, 1),
		profileRevision: integer(profileRevision, 1),
		avatarPolicyRevision: integer(avatarPolicyRevision),
		pinned: bool(pinned),
	};
}
export function parseAvatarAsset(value: unknown): AvatarAsset {
	const v = exact(value, "sha256,mime,size");
	if (v["mime"] !== "image/png" && v["mime"] !== "image/jpeg")
		throw Error("invalid visual mime");
	return {
		sha256: hash(v["sha256"]),
		mime: v["mime"],
		size: integer(v["size"], 1, MAX_AVATAR_BYTES),
	};
}
function ownedVisualAssetId(value: unknown): string {
	const id = boundedId(value, "visual asset id");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id))
		throw Error("invalid owned visual asset id");
	return id;
}
export function parseVisualReference(value: unknown): VisualReference {
	const v = exact(value, "version,id,agentId,assetId,sha256,mime,size,origin");
	const raw = v["origin"] as VisualReference["origin"];
	let origin: VisualReference["origin"];
	if (raw?.kind === "upload") {
		exact(raw, "kind");
		origin = { kind: "upload" };
	} else if (raw?.kind === "avatar") {
		const o = exact(raw, "kind,avatarId");
		origin = { kind: "avatar", avatarId: hash(o["avatarId"]) };
		if (origin.avatarId !== v["sha256"])
			throw Error("avatar reference hash conflict");
	} else {
		const o = exact(raw, "kind,binding,artifactId");
		if (o["kind"] !== "attachment") throw Error("invalid visual origin");
		const b = exact(
			o["binding"],
			"version,botId,sessionId,sessionFile,workspace",
		);
		const binding: BotBinding = {
			version: one(b["version"]),
			botId: boundedId(b["botId"], "bot"),
			sessionId: boundedId(b["sessionId"], "session"),
			sessionFile: boundedText(b["sessionFile"], "session file", 4096),
			workspace: boundedText(b["workspace"], "workspace", 4096),
		};
		origin = {
			kind: "attachment",
			binding,
			artifactId: boundedId(o["artifactId"], "artifact"),
		};
	}
	return {
		version: one(v["version"]),
		id: boundedId(v["id"], "reference"),
		agentId: boundedId(v["agentId"], "agent"),
		assetId: ownedVisualAssetId(v["assetId"]),
		...parseAvatarAsset({
			sha256: v["sha256"],
			mime: v["mime"],
			size: v["size"],
		}),
		origin,
	};
}
export function parseVisualGrant(value: unknown): VisualGrant {
	const v = exact(
		value,
		"version,id,agentId,revision,subject,providerUse,purposes,revoked",
	);
	const raw = v["subject"] as VisualGrant["subject"];
	let subject: VisualGrant["subject"];
	if (raw?.kind === "reference") {
		const s = exact(raw, "kind,referenceId,sha256");
		subject = {
			kind: "reference",
			referenceId: boundedId(s["referenceId"], "reference"),
			sha256: hash(s["sha256"]),
		};
	} else {
		const s = exact(raw, "kind,identityDigest");
		if (s["kind"] !== "text_identity")
			throw Error("invalid visual grant subject");
		subject = {
			kind: "text_identity",
			identityDigest: hash(s["identityDigest"]),
		};
	}
	if (!Array.isArray(v["purposes"]) || v["purposes"].length > 128)
		throw Error("invalid visual purposes");
	const purposes = v["purposes"].map(parseVisualPurpose);
	if (new Set(purposes.map(visualDigest)).size !== purposes.length)
		throw Error("duplicate visual purpose");
	return {
		version: one(v["version"]),
		id: boundedId(v["id"], "grant"),
		agentId: boundedId(v["agentId"], "agent"),
		revision: integer(v["revision"], 1),
		subject,
		providerUse: bool(v["providerUse"]),
		purposes,
		revoked: bool(v["revoked"]),
	};
}
export function parseGrantRefs(value: unknown): VisualGrantRef[] {
	if (!Array.isArray(value) || value.length > 128)
		throw Error("invalid visual grant references");
	const refs = value.map((item) => {
		const v = exact(item, "grantId,revision,purpose");
		return {
			grantId: boundedId(v["grantId"], "grant"),
			revision: integer(v["revision"], 1),
			purpose: parseVisualPurpose(v["purpose"]),
		};
	});
	if (new Set(refs.map((r) => r.grantId)).size !== refs.length)
		throw Error("duplicate visual grant reference");
	return refs;
}
export function parseAvatarSource(value: unknown): AvatarSourceProof {
	const raw = value as AvatarSourceProof;
	if (raw?.kind === "avatar_wall" || raw?.kind === "avatar_steps") {
		const v = exact(
			value,
			raw.kind === "avatar_wall"
				? "kind,scheduleKey,slotIndex,dueAtMs,resolvedPolicyId"
				: "kind,scheduleKey,slotIndex,dueLifeRevision,resolvedPolicyId",
		);
		const common = {
			scheduleKey: hash(v["scheduleKey"]),
			slotIndex: integer(v["slotIndex"]),
			resolvedPolicyId: boundedId(v["resolvedPolicyId"], "resolved policy"),
		};
		return raw.kind === "avatar_wall"
			? { ...common, kind: "avatar_wall", dueAtMs: integer(v["dueAtMs"]) }
			: {
					...common,
					kind: "avatar_steps",
					dueLifeRevision: integer(v["dueLifeRevision"]),
				};
	}
	const v = exact(
		value,
		"kind,resolvedPolicyId,eventId,worldRevision,lifeRevision,familyId,stepId,triggerSettingsRevision,triggerDigest",
	);
	if (v["kind"] !== "avatar_event") throw Error("invalid avatar source");
	return {
		kind: "avatar_event",
		resolvedPolicyId: boundedId(v["resolvedPolicyId"], "resolved policy"),
		eventId: boundedId(v["eventId"], "avatar_event"),
		worldRevision: integer(v["worldRevision"]),
		lifeRevision: integer(v["lifeRevision"]),
		familyId: boundedId(v["familyId"], "family"),
		stepId: boundedId(v["stepId"], "accepted step"),
		triggerSettingsRevision: integer(v["triggerSettingsRevision"], 1),
		triggerDigest: hash(v["triggerDigest"]),
	};
}
export function parseAvatarAdmission(value: unknown): AvatarAdmission {
	const v = exact(
		value,
		"agentId,worldId,intentId,materialDigest,resolvedPolicyId,profileRevision,visualRevision,avatarPolicyRevision,source,grants",
	);
	const result: AvatarAdmission = {
		agentId: boundedId(v["agentId"], "agent"),
		worldId: boundedId(v["worldId"], "world"),
		intentId: boundedId(v["intentId"], "intent"),
		materialDigest: hash(v["materialDigest"]),
		resolvedPolicyId: boundedId(v["resolvedPolicyId"], "resolved policy"),
		profileRevision: integer(v["profileRevision"], 1),
		visualRevision: integer(v["visualRevision"], 1),
		avatarPolicyRevision: integer(v["avatarPolicyRevision"], 1),
		source: parseAvatarSource(v["source"]),
		grants: parseGrantRefs(v["grants"]),
	};
	if (result.source.resolvedPolicyId !== result.resolvedPolicyId)
		throw Error("avatar resolved policy conflict");
	return result;
}
export function parseAvatarCandidate(value: unknown): GeneratedAvatarCandidate {
	const v = exact(
		value,
		"version,kind,candidateId,attemptId,providerGenerationId,artifact,avatar,agentId,worldId,intentId,materialDigest,resolvedPolicyId,profileRevision,visualRevision,avatarPolicyRevision,source,grants",
	);
	const {
		version,
		kind,
		candidateId,
		attemptId,
		providerGenerationId,
		artifact,
		avatar,
		...admission
	} = v;
	if (kind !== "generated") throw Error("invalid candidate kind");
	const a = exact(artifact, "id,sha256,mime,size");
	const generation = boundedId(providerGenerationId, "generation");
	if (
		a["id"] !== generation ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			generation,
		)
	)
		throw Error("invalid avatar artifact generation UUID");
	return {
		...parseAvatarAdmission(admission),
		version: one(version),
		kind,
		candidateId: boundedId(candidateId, "candidate"),
		attemptId: boundedId(attemptId, "attempt"),
		providerGenerationId: generation,
		artifact: {
			id: generation,
			...parseAvatarAsset({
				sha256: a["sha256"],
				mime: a["mime"],
				size: a["size"],
			}),
		},
		avatar: parseAvatarAsset(avatar),
	};
}
export function parseAvatarApply(value: unknown): AvatarApplyInput {
	const v = exact(
		value,
		"requestKey,candidateId,expectedProfileRevision,expectedVisualRevision,mode",
	);
	if (
		v["mode"] !== "automatic" &&
		v["mode"] !== "manual" &&
		v["mode"] !== "restore"
	)
		throw Error("invalid avatar mode");
	return {
		requestKey: boundedId(v["requestKey"], "request key"),
		candidateId: boundedId(v["candidateId"], "candidate"),
		expectedProfileRevision: integer(v["expectedProfileRevision"], 1),
		expectedVisualRevision: integer(v["expectedVisualRevision"], 1),
		mode: v["mode"],
	};
}
export function visualIdentityDigest(
	input: Pick<VisualInput, "anchors" | "textIdentity">,
): string {
	return visualDigest({
		anchors: input.anchors,
		textIdentity: input.textIdentity,
	});
}
export { parseAvatarSource as parseAvatarSourceProof };
export function parseFrozenVisualIdentity(
	value: unknown,
): import("./visual.ts").FrozenVisualIdentity {
	const v = exact(
		value,
		"agentId,profileRevision,visualRevision,avatarPolicyRevision,anchors,textIdentity,reference,grants",
	);
	const reference =
			v["reference"] === null ? null : parseVisualReference(v["reference"]),
		agentId = boundedId(v["agentId"], "agent");
	if (reference && reference.agentId !== agentId)
		throw Error("frozen visual reference owner conflict");
	return {
		agentId,
		profileRevision: integer(v["profileRevision"], 1),
		visualRevision: integer(v["visualRevision"], 1),
		avatarPolicyRevision: integer(v["avatarPolicyRevision"]),
		anchors: boundedList(v["anchors"], "anchors"),
		textIdentity:
			v["textIdentity"] === null
				? null
				: boundedText(v["textIdentity"], "identity", 3000),
		reference,
		grants: parseGrantRefs(v["grants"]),
	};
}

export function avatarAutomaticRequestKey(
	candidate: Pick<
		GeneratedAvatarCandidate,
		"agentId" | "intentId" | "attemptId"
	>,
): string {
	return `avatar-auto:${visualDigest({ agentId: candidate.agentId, intentId: candidate.intentId, attemptId: candidate.attemptId })}`;
}
/** Persisted references must resolve; missing rows never become empty authority. */
export function requireVisualRecord<T>(value: T | undefined): T {
	if (value === undefined) throw Error("missing visual record");
	return value;
}
