import { z } from "zod";
import type {
	ResourceActivityReceipt,
	ResourceActivitySource,
} from "../../../lina-core/src/world/work-types.ts";
import type { ActivitySnapshot } from "./activity-source.ts";
import { counter, identity, uuid } from "./codec.ts";

const activityKind = z.enum([
	"development",
	"research",
	"writing",
	"organization",
	"search",
	"other",
]);
const outcome = z.enum(["recorded", "verified_result", "failed"]);
const fieldsSchema = z.strictObject({
	categoryId: identity,
	outcome: outcome.nullable(),
	participantAgentIds: z.array(identity).max(64).nullable(),
	summary: z.string().min(1).max(32768).nullable(),
});
const quotesSchema = z.array(z.string().min(1).max(8192)).max(16);
export const createSchema = z.strictObject({
	operationId: identity,
	activityId: identity,
	worldId: identity,
	actorAgentId: identity,
	participantAgentIds: z.array(identity).min(1).max(64),
	activityKind,
	outcome,
	resourceId: uuid,
	versionId: uuid.nullable(),
	memoryId: uuid.nullable(),
	quotes: quotesSchema,
	hostConfirmed: z.boolean(),
	fields: fieldsSchema,
	policyRevision: counter.min(1),
});
export const correctSchema = createSchema
	.omit({
		worldId: true,
		actorAgentId: true,
		participantAgentIds: true,
		activityKind: true,
		resourceId: true,
		versionId: true,
	})
	.extend({
		expectedRevision: counter.min(1),
		correction: z.strictObject({
			kind: z.enum(["amend", "retract"]),
			reason: z.string().min(1).max(32768),
		}),
	});
export const grantSchema = z.strictObject({
	operationId: identity,
	activityId: identity,
	expectedRevision: counter.min(1),
	worldId: identity,
	fields: fieldsSchema,
	policyRevision: counter.min(1),
});
export const restrictSchema = grantSchema.omit({ fields: true });
export const ackSchema = z.strictObject({
	operationId: identity,
	deliveryId: identity,
	sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const snapshotSchema = z.strictObject({
	resourceId: uuid,
	resourceRevision: counter.min(1),
	versionId: uuid,
	blobHash: z.string().length(64),
	mediaType: z.string().min(1).max(128),
	visibility: z.enum(["private", "shared"]),
	ownerId: identity,
	memoryId: uuid.nullable(),
	quotes: z.array(
		z.strictObject({
			quote: z.string().min(1).max(8192),
			quoteHash: z.string().length(64),
			memoryId: uuid.nullable(),
		}),
	),
});
export const grantStateSchema = z.strictObject({
	grantId: identity,
	grantRevision: counter.min(1),
	worldId: identity,
	actorAgentId: identity,
	fields: fieldsSchema.nullable(),
	policyRevision: counter.min(1),
	revoked: z.boolean(),
});
export const recordSchema = z.strictObject({
	receipt: z.unknown(),
	snapshot: snapshotSchema,
	grant: grantStateSchema,
	hostConfirmed: z.boolean(),
});
export const deliveryRowSchema = z.strictObject({
	source: z.unknown(),
	snapshot: snapshotSchema,
	ackOperationId: identity.nullable(),
	ackFingerprint: z.string().length(64).nullable(),
});
export const resultSchema = z.strictObject({
	activity: recordSchema,
	delivery: z.unknown().nullable(),
});

export type ResourceActivityCreate = z.input<typeof createSchema>;
export type ResourceActivityCorrect = z.input<typeof correctSchema>;
export type ResourceActivityGrant = z.input<typeof grantSchema>;
export type ResourceActivityRestrict = z.input<typeof restrictSchema>;
export type ResourceActivityAck = z.input<typeof ackSchema>;
export interface ResourceActivityRecord {
	receipt: ResourceActivityReceipt;
	snapshot: ActivitySnapshot;
	grant: z.infer<typeof grantStateSchema>;
	hostConfirmed: boolean;
}
export interface ResourceActivityDeliveryRecord {
	state: "pending" | "acknowledged" | "withheld";
	source: ResourceActivitySource;
}
