import { createHash } from "node:crypto";
import { z } from "zod";

export const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const identity = z.string().min(1).max(160);
export const uuid = z.uuid();
export function resourceUri(id: string): string {
	return `lina://resources/${uuid.parse(id)}`;
}
export function resourceId(address: string): string {
	return uuid.parse(
		address.startsWith("lina://resources/")
			? address.slice("lina://resources/".length)
			: address,
	);
}
export const visibility = z.enum(["private", "shared"]);
const bytesSchema = z
	.custom<Uint8Array>((value) => value instanceof Uint8Array)
	.refine(
		(value) => value.byteLength <= 64 * 1024 * 1024,
		"resource input limit exceeded",
	)
	.transform((value) => Uint8Array.from(value));
export const scopeSchema = z.strictObject({
	principalId: identity,
	agentId: identity,
	allowedVisibilities: z
		.array(visibility)
		.max(2)
		.refine((v) => new Set(v).size === v.length),
});
export const refSchema = z.strictObject({
	resourceId: uuid,
	resourceRevision: counter.min(1),
	versionId: uuid.nullable(),
});
export const resourceSchema = z
	.strictObject({
		id: uuid,
		kind: z.enum(["document", "collection"]),
		title: z.string().min(1).max(512),
		parentId: uuid.nullable(),
		collectionIds: z.array(uuid).max(64),
		currentVersion: uuid.nullable(),
		revision: counter.min(1),
		mediaType: z.string().min(1).max(128).nullable(),
		ownerId: identity,
		visibility,
		deleted: z.boolean(),
		createdAt: counter,
		updatedAt: counter,
	})
	.superRefine((v, c) => {
		if (
			(v.kind === "collection" &&
				(v.currentVersion !== null ||
					v.mediaType !== null ||
					v.collectionIds.length)) ||
			(v.kind === "document" && (!v.currentVersion || !v.mediaType)) ||
			new Set(v.collectionIds).size !== v.collectionIds.length ||
			v.updatedAt < v.createdAt
		)
			c.addIssue({ code: "custom", message: "invalid resource state" });
	});
export const versionSchema = z.strictObject({
	id: uuid,
	resourceId: uuid,
	resourceRevision: counter.min(1),
	ownerId: identity,
	visibility,
	mediaType: z.string().min(1).max(128),
	hash: z.string().regex(/^[a-f0-9]{64}$/),
	byteLength: counter.max(64 * 1024 * 1024),
	createdAt: counter,
});
export const createSchema = z.strictObject({
	operationId: identity,
	kind: z.enum(["document", "collection"]),
	title: z.string().trim().min(1).max(512),
	visibility,
	parentId: uuid.nullable().default(null),
	mediaType: z.string().min(1).max(128).optional(),
	bytes: bytesSchema.optional(),
});
export const updateSchema = z.strictObject({
	operationId: identity,
	id: uuid,
	expectedRevision: counter.min(1),
	title: z.string().trim().min(1).max(512).optional(),
	parentId: uuid.nullable().optional(),
	collectionIds: z.array(uuid).max(64).optional(),
	visibility: visibility.optional(),
	deleted: z.literal(true).optional(),
	mediaType: z.string().min(1).max(128).optional(),
	bytes: bytesSchema.optional(),
});
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function hash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function byteHash(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
export function decode<T>(schema: z.ZodType<T>, value: unknown): T {
	if (typeof value !== "string") throw Error("corrupt resource JSON");
	return schema.parse(JSON.parse(value));
}

export const savedInputSchema = z.union([
	createSchema.omit({ bytes: true }).extend({
		bytes: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		principalId: identity,
	}),
	updateSchema.omit({ bytes: true }).extend({
		bytes: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		principalId: identity,
	}),
]);
