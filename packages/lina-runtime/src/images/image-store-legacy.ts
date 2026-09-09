import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AttachmentMetadata } from "../../../lina-core/src/attachments/types.ts";
import {
	ATTACHMENT_MAX_BYTES,
	metadataShape,
} from "../../../lina-core/src/attachments/validation.ts";
import { resultSchema } from "./client-contract.ts";
export const MAX_JOBS = 256;
export const MAX_STORE_BYTES = 8 * 1024 * 1024;
const uuid = Type.String({
	pattern:
		"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
	Type.Union([schema, Type.Null()]);
export const legacyInputSchema = Type.Object(
	{
		requestId: text(256),
		callId: text(256),
		provider: text(128),
		model: text(256),
		prompt: text(16000),
		sourceArtifactId: nullable(uuid),
	},
	{ additionalProperties: false },
);
export const legacyRecordSchema = Type.Object(
	{
		...legacyInputSchema.properties,
		id: uuid,
		state: Type.Union([
			Type.Literal("prepared"),
			Type.Literal("submitting"),
			Type.Literal("queued"),
			Type.Literal("running"),
			Type.Literal("post_processing"),
			Type.Literal("uncertain"),
			Type.Literal("cancelling"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		endpoint: nullable(text(2048)),
		runtimeVersion: nullable(text(128)),
		createdAt: text(64),
		updatedAt: text(64),
		error: nullable(text(512)),
		cancelRequested: Type.Boolean(),
		resultFilename: nullable(text(255)),
		deliveryError: nullable(text(512)),
		artifact: Type.Union([
			Type.Object(
				{
					id: uuid,
					name: text(120),
					mime: text(128),
					size: Type.Integer({ minimum: 1, maximum: ATTACHMENT_MAX_BYTES }),
					sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				},
				{ additionalProperties: false },
			),
			Type.Null(),
		]),
		deliveredEntryId: nullable(text(256)),
	},
	{ additionalProperties: false },
);
export type LegacyImageInput = Static<typeof legacyInputSchema>;
export type ImageJobState = Static<typeof legacyRecordSchema>["state"];
export type LegacyImageJob = Omit<
	Static<typeof legacyRecordSchema>,
	"artifact"
> & {
	artifact: AttachmentMetadata | null;
};
export function terminalImageState(state: ImageJobState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}
export function parseLegacyJob(raw: unknown): LegacyImageJob {
	if (!Value.Check(legacyRecordSchema, raw))
		throw Error("Invalid image job record");
	validateImageResult(raw);
	return raw as LegacyImageJob;
}
export function validateImageResult(
	raw: Pick<LegacyImageJob, "id" | "state" | "resultFilename"> & {
		artifact: unknown;
	},
): void {
	if (
		raw.resultFilename !== null &&
		!resultSchema.safeParse({ requestId: raw.id, filename: raw.resultFilename })
			.success
	)
		throw Error("Invalid image result filename");
	if (raw.artifact) {
		metadataShape(raw.artifact);
		if (metadataShape(raw.artifact).id !== raw.id)
			throw Error("Invalid image artifact identity");
	}
	if ((raw.state === "completed") !== (raw.artifact !== null))
		throw Error("Invalid image artifact state");
}
