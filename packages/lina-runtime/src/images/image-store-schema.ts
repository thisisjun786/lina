import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { validateBinding } from "../../../lina-core/src/session-binding.ts";
import type {
	ImageJob,
	ImageJobInput,
	ImageOrigin,
	ImageOwner,
} from "./contracts.ts";
import {
	type LegacyImageJob,
	legacyInputSchema,
	legacyRecordSchema,
	terminalImageState,
	validateImageResult,
} from "./image-store-legacy.ts";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const exact = { additionalProperties: false };
const conversationOwner = Type.Object(
	{ kind: Type.Literal("conversation"), binding: Type.Unknown() },
	exact,
);
const lifeOrigin = Type.Object(
	{
		kind: Type.Literal("life"),
		intentId: text(256),
		attemptId: text(256),
		briefDigest: digest,
	},
	exact,
);
const originSchema = Type.Union([
	lifeOrigin,
	Type.Object(
		{
			kind: Type.Literal("conversation"),
			requestId: text(256),
			callId: text(256),
		},
		exact,
	),
]);
const referenceSchema = Type.Union([
	Type.Null(),
	Type.Object(
		{
			owner: Type.Union([
				conversationOwner,
				Type.Object({ kind: Type.Literal("agent"), agentId: text(256) }, exact),
			]),
			referenceId: text(256),
			assetId: text(256),
			sha256: digest,
			mime: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
			size: Type.Integer({ minimum: 1, maximum: 2_097_152 }),
		},
		exact,
	),
]);
const lifeInputSchema = Type.Object(
	{
		origin: lifeOrigin,
		reference: referenceSchema,
		provider: text(128),
		model: text(256),
		prompt: text(16000),
	},
	exact,
);
const completionSchema = Type.Union([
	Type.Object({ kind: Type.Literal("pending") }, exact),
	Type.Object(
		{ kind: Type.Literal("conversation"), entryId: text(256) },
		exact,
	),
	Type.Object({ kind: Type.Literal("life"), receiptId: text(256) }, exact),
]);
const ownerSchema = Type.Union([
	conversationOwner,
	Type.Object(
		{ kind: Type.Literal("life"), worldId: text(256), agentId: text(256) },
		exact,
	),
]);
const recordSchema = Type.Object(
	{
		...legacyRecordSchema.properties,
		requestId: Type.Union([text(256), Type.Null()]),
		callId: Type.Union([text(256), Type.Null()]),
		owner: ownerSchema,
		origin: originSchema,
		reference: referenceSchema,
		delivery: completionSchema,
		artifactRecovery: Type.Union([
			Type.Null(),
			Type.Object(
				{
					failedAt: text(64),
					error: legacyRecordSchema.properties.error,
					delivery: completionSchema,
				},
				exact,
			),
		]),
	},
	exact,
);

export type { ImageJob } from "./contracts.ts";
export function parseOwner(raw: unknown): ImageOwner {
	if (!Value.Check(ownerSchema, raw))
		throw Error("Invalid image owner binding");
	if (raw.kind === "conversation")
		return { kind: "conversation", binding: validateBinding(raw.binding) };
	return structuredClone(raw);
}
export function originKey(origin: ImageOrigin): string {
	return JSON.stringify(
		origin.kind === "conversation"
			? [origin.kind, origin.requestId, origin.callId]
			: [origin.kind, origin.intentId, origin.attemptId],
	);
}
export function inputFor(job: ImageJob): ImageJobInput {
	const common = {
		provider: job.provider,
		model: job.model,
		prompt: job.prompt,
	};
	if (job.origin.kind === "conversation")
		return {
			...common,
			requestId: job.origin.requestId,
			callId: job.origin.callId,
			sourceArtifactId: job.sourceArtifactId,
		};
	return { ...common, origin: job.origin, reference: job.reference };
}
export function parseInput(raw: unknown, owner: ImageOwner): ImageJobInput {
	const schema =
		owner.kind === "conversation" ? legacyInputSchema : lifeInputSchema;
	if (!Value.Check(schema, raw)) throw Error("Invalid image request");
	// Schema selection and reference-owner parsing are the file/tool trust boundary.
	const input = raw as ImageJobInput;
	if ("reference" in input && input.reference?.owner.kind === "conversation")
		validateBinding(input.reference.owner.binding);
	return structuredClone(input);
}
export function migrateJob(job: LegacyImageJob, owner: ImageOwner): ImageJob {
	if (owner.kind !== "conversation") throw Error("Invalid legacy image owner");
	return {
		...job,
		owner,
		origin: {
			kind: "conversation",
			requestId: job.requestId,
			callId: job.callId,
		},
		reference: null,
		delivery: job.deliveredEntryId
			? { kind: "conversation", entryId: job.deliveredEntryId }
			: { kind: "pending" },
		artifactRecovery: null,
	};
}
export function parseJob(raw: unknown, owner: ImageOwner): ImageJob {
	if (!Value.Check(recordSchema, raw)) throw Error("Invalid image job record");
	if (
		!isDeepStrictEqual(parseOwner(raw.owner), owner) ||
		raw.origin.kind !== owner.kind
	)
		throw Error("Invalid image job owner binding");
	const {
		owner: _owner,
		origin,
		reference,
		delivery,
		artifactRecovery,
		...old
	} = raw;
	validateImageResult(old);
	if (origin.kind === "conversation") {
		if (
			old.requestId !== origin.requestId ||
			old.callId !== origin.callId ||
			reference !== null ||
			artifactRecovery !== null
		)
			throw Error("Invalid conversation image origin");
	} else {
		if (
			old.requestId !== null ||
			old.callId !== null ||
			old.sourceArtifactId !== null
		)
			throw Error("Invalid LIFE image origin");
		if (reference?.owner.kind === "conversation")
			validateBinding(reference.owner.binding);
		if (
			old.state === "prepared" &&
			(old.endpoint !== null || old.runtimeVersion !== null)
		)
			throw Error("Invalid prepared LIFE provenance");
		if (artifactRecovery && old.state !== "completed")
			throw Error("Invalid artifact recovery state");
	}
	if (delivery.kind !== "pending" && delivery.kind !== owner.kind)
		throw Error("Foreign image completion receipt");
	if (
		(delivery.kind === "conversation" ? delivery.entryId : null) !==
		old.deliveredEntryId
	)
		throw Error("Invalid image delivery identity");
	if (artifactRecovery && artifactRecovery.delivery.kind === "conversation")
		throw Error("Foreign recovery receipt");
	return structuredClone(raw) as ImageJob;
}
export function validateRecords(jobs: ImageJob[]): void {
	if (
		new Set(jobs.map((j) => j.id)).size !== jobs.length ||
		new Set(jobs.map((j) => originKey(j.origin))).size !== jobs.length
	)
		throw Error("Invalid image store records");
}
export function archiveEligible(job: ImageJob): boolean {
	return (
		terminalImageState(job.state) &&
		job.delivery.kind !== "pending" &&
		!(job.state === "failed" && job.owner.kind === "life" && job.resultFilename)
	);
}

/** Terminal generation changes only once: failed LIFE import -> recovered completed artifact. */
export function sameImageTerminal(a: ImageJob, b: ImageJob): boolean {
	return (
		a.id === b.id &&
		a.state === b.state &&
		terminalImageState(a.state) &&
		(a.artifactRecovery !== null) === (b.artifactRecovery !== null)
	);
}
