import { z } from "zod";
import {
	ATTACHMENT_MAX_BYTES,
	inspectContent,
} from "../../../lina-core/src/attachments/validation.ts";
import {
	Ima2Error,
	type Ima2ImageMime,
	type Ima2Job,
	type Ima2Lane,
	type Ima2Result,
} from "./client-types.ts";

export const IMA2_VERSION = "3.14.0";
export const IMAGE_MAX_BYTES = ATTACHMENT_MAX_BYTES;
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const identifier = z.string().min(1).max(255);
const filenameSchema = z
	.string()
	.min(5)
	.max(255)
	.regex(/\.(?:png|jpe?g)$/i)
	.refine(
		(value) =>
			!value.startsWith(".") &&
			!/[\\/%?#:]/u.test(value) &&
			Buffer.byteLength(value, "utf8") <= 255 &&
			[...value].every((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code > 0x1f && !(code >= 0x7f && code <= 0x9f);
			}),
	);
export const resultSchema = z.strictObject({
	requestId: requestIdSchema,
	filename: filenameSchema,
});
export const submitSchema = z.strictObject({
	requestId: requestIdSchema,
	provider: identifier,
	model: identifier,
	prompt: z.string().min(1).max(32_000),
	reference: z
		.strictObject({
			bytes: z.instanceof(Uint8Array),
			mime: z.enum(["image/png", "image/jpeg"]),
		})
		.optional(),
});
export const healthSchema = z.object({
	ok: z.literal(true),
	version: z.string(),
});
export const cancelSchema = z.object({
	requestId: requestIdSchema,
	active: z.boolean(),
	aborted: z.boolean(),
});
export const acceptedSchema = z.object({
	requestId: requestIdSchema,
	async: z.literal(true),
});
export const replaySchema = z.object({
	requestId: requestIdSchema,
	filename: filenameSchema,
	provider: identifier,
	model: identifier,
	idempotentReplay: z.literal(true),
});

// Known /api/generate dispatch branches at 36aa6fc. Unknown providers fall
// through to oauth upstream. agy ignores rawModel, so cannot honor selection.
const GENERATE_PROVIDERS = new Set([
	"oauth",
	"api",
	"grok",
	"grok-api",
	"gemini-api",
	"atlascloud",
	"minimax",
	"nai",
	"comfy",
]);
const modelSchema = z.object({
	id: identifier,
	label: z.string().max(255),
	capabilities: z.object({ inputRoles: z.array(z.string()) }).optional(),
});
const laneSchema = z.object({
	status: z.enum(["ready", "locked", "disconnected", "key-missing"]),
	models: z.object({ image: z.array(modelSchema) }),
	surfaces: z
		.object({
			generate: z
				.object({ supported: z.boolean(), references: z.boolean() })
				.optional(),
		})
		.optional(),
});
const catalogSchema = z.object({
	ok: z.literal(true),
	lanes: z.record(identifier, laneSchema),
});

export function parse<T>(
	schema: z.ZodType<T>,
	value: unknown,
	code:
		| "INVALID_INPUT"
		| "INVALID_RESULT"
		| "INVALID_RESPONSE" = "INVALID_RESPONSE",
): T {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new Ima2Error(code, "ima2 data did not match the required contract");
	return result.data;
}

export function catalogLanes(value: unknown): Ima2Lane[] {
	return Object.entries(parse(catalogSchema, value).lanes).map(
		([provider, lane]) => {
			const surface = lane.surfaces?.generate;
			const generate =
				GENERATE_PROVIDERS.has(provider) && surface?.supported === true;
			return {
				provider,
				status: lane.status,
				models: lane.models.image.map((model) => ({
					id: model.id,
					label: model.label,
					generate,
					edit:
						generate &&
						surface?.references === true &&
						model.capabilities?.inputRoles.includes("image_references") ===
							true,
				})),
			};
		},
	);
}

export function imageMime(
	bytes: Uint8Array,
	mime: string,
	maxBytes: number,
): Ima2ImageMime {
	if (bytes.byteLength > maxBytes)
		throw new Ima2Error(
			"BODY_TOO_LARGE",
			"Image exceeds the configured byte limit",
		);
	if (mime !== "image/png" && mime !== "image/jpeg")
		throw new Ima2Error(
			"INVALID_IMAGE",
			"Only PNG and JPEG images are supported",
		);
	try {
		// Reuse managed attachment container, checksum, and dimension validation.
		inspectContent(mime === "image/png" ? "image.png" : "image.jpg", bytes);
	} catch {
		throw new Ima2Error(
			"INVALID_IMAGE",
			"Image bytes do not match a supported image container",
		);
	}
	return mime;
}

const jobRowSchema = z.object({
	requestId: requestIdSchema,
	kind: z.string(),
	phase: z.string(),
});
const terminalSchema = jobRowSchema.extend({
	status: z.string(),
	errorCode: z.string().optional(),
	meta: z.object({
		filenames: z.array(z.string()).optional(),
		imageCount: z.number().optional(),
	}),
});
const inflightSchema = z.object({
	jobs: z.array(z.unknown()),
	terminalJobs: z.array(z.unknown()),
});
const historySchema = z.object({
	items: z.array(z.object({ requestId: z.string(), filename: z.string() })),
	nextCursor: z.unknown().optional(),
});
const identitySchema = z.object({ requestId: z.string() });

function matching(rows: unknown[], requestId: string): unknown[] {
	return rows.filter(
		(row) => parse(identitySchema, row).requestId === requestId,
	);
}

function completed(requestId: string, filenames: string[]): Ima2Job {
	if (filenames.length !== 1)
		throw new Ima2Error(
			"INVALID_RESPONSE",
			"ima2 must return exactly one image",
		);
	const result: Ima2Result = parse(resultSchema, {
		requestId,
		filename: filenames[0],
	});
	return { requestId, state: "completed", result };
}

function failed(
	requestId: string,
	state: "failed" | "cancelled" | "timed_out",
): Ima2Job {
	const messages = {
		failed: { code: "GENERATION_FAILED", message: "ima2 generation failed" },
		cancelled: {
			code: "GENERATION_CANCELED",
			message:
				"ima2 marked the job cancelled; provider completion is not guaranteed",
		},
		timed_out: {
			code: "JOB_TRACKING_TIMEOUT",
			message: "ima2 tracking expired; provider completion is unknown",
		},
	};
	return { requestId, state, error: messages[state] };
}

export function inflightJob(
	value: unknown,
	requestId: string,
): Ima2Job | undefined {
	const data = parse(inflightSchema, value);
	const active = matching(data.jobs, requestId);
	const terminal = matching(data.terminalJobs, requestId);
	if (active.length + terminal.length > 1)
		throw new Ima2Error(
			"INVALID_RESPONSE",
			"ima2 returned conflicting job identities",
		);
	if (terminal.length === 1) {
		const row = parse(terminalSchema, terminal[0]);
		// abortJob creates this tombstone even when no generation is known.
		// It is not cancellation evidence; let read() check saved history.
		if (row.kind === "unknown" && row.status === "canceled") return undefined;
		if (row.kind !== "classic")
			throw new Ima2Error(
				"INVALID_RESPONSE",
				"ima2 job is not a classic image request",
			);
		if (row.errorCode === "JOB_TRACKING_TIMEOUT")
			return failed(requestId, "timed_out");
		if (["done", "completed", "complete"].includes(row.status)) {
			if (row.meta.imageCount !== undefined && row.meta.imageCount !== 1)
				throw new Ima2Error(
					"INVALID_RESPONSE",
					"ima2 returned an unexpected image count",
				);
			return completed(requestId, row.meta.filenames ?? []);
		}
		if (["canceled", "cancelled"].includes(row.status))
			return failed(requestId, "cancelled");
		if (["error", "failed"].includes(row.status))
			return failed(requestId, "failed");
		return { requestId, state: "unknown" };
	}
	if (active.length === 0) return undefined;
	const row = parse(jobRowSchema, active[0]);
	if (row.kind !== "classic")
		throw new Ima2Error(
			"INVALID_RESPONSE",
			"ima2 job is not a classic image request",
		);
	if (
		[
			"queued",
			"validating",
			"preparing",
			"planning",
			"provider-queued",
		].includes(row.phase)
	)
		return { requestId, state: "queued" };
	if (
		[
			"streaming",
			"partial",
			"uploading",
			"provider-running",
			"provider-poll",
			"polling",
			"progress",
			"submitted",
		].includes(row.phase)
	)
		return { requestId, state: "running" };
	if (
		["decoding", "downloading", "media-processing", "persisting"].includes(
			row.phase,
		)
	)
		return { requestId, state: "post_processing" };
	return { requestId, state: "unknown" };
}

export function historyJob(value: unknown, requestId: string): Ima2Job {
	const data = parse(historySchema, value);
	if (data.items.some((item) => item.requestId !== requestId))
		throw new Ima2Error(
			"INVALID_RESPONSE",
			"ima2 history returned a different request identity",
		);
	if (data.items.length === 0) return { requestId, state: "unknown" };
	if (data.nextCursor)
		throw new Ima2Error(
			"INVALID_RESPONSE",
			"ima2 history returned more than one image",
		);
	return completed(
		requestId,
		data.items.map((item) => item.filename),
	);
}
