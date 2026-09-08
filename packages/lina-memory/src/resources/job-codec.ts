import { z } from "zod";
import { counter, identity, refSchema, uuid, visibility } from "./codec.ts";
export const indexKind = z.enum(["extract", "brief", "overview"]);
export const generationSchema = z.strictObject({
	policyRevision: counter,
	modelSettingsRevision: counter,
	routeKey: z.string().min(1).max(4096),
	estimatorId: identity,
	maxAttempts: counter.min(1).max(3),
});
export const jobSchema = z
	.strictObject({
		id: z.string().regex(/^[a-f0-9]{64}$/),
		resourceId: uuid,
		sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
		kind: indexKind,
		ownerId: identity,
		visibility,
		refs: z.array(refSchema).min(1).max(64),
		complete: z.boolean(),
		generation: generationSchema,
		state: z.enum([
			"pending",
			"prepared",
			"ready",
			"failed",
			"unknown",
			"unavailable",
			"stale",
			"exhausted",
		]),
		token: uuid.nullable(),
		attempt: counter.max(3),
		inputHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		error: z.string().max(256).nullable(),
		outputHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
	})
	.superRefine((v, c) => {
		if ((v.state === "prepared") !== (v.token !== null))
			c.addIssue({ code: "custom", message: "invalid resource claim state" });
		if (
			(v.state === "ready") !== (v.outputHash !== null) ||
			new Set(v.refs.map((r) => r.resourceId)).size !== v.refs.length
		)
			c.addIssue({
				code: "custom",
				message: "invalid resource output or sources",
			});
	});
export const derivationSchema = z.strictObject({
	jobId: z.string().regex(/^[a-f0-9]{64}$/),
	text: z.string().max(262144),
	complete: z.boolean(),
});
export type IndexKind = z.infer<typeof indexKind>;
export type ResourceGeneration = z.infer<typeof generationSchema>;
export type ResourceJob = z.infer<typeof jobSchema>;
export type ResourceDerivation = z.infer<typeof derivationSchema>;
export interface ResourceClaim {
	id: string;
	token: string;
}
export const UNCONFIGURED_RESOURCE_GENERATION: ResourceGeneration = {
	policyRevision: 0,
	modelSettingsRevision: 0,
	routeKey: "unconfigured",
	estimatorId: "unconfigured",
	maxAttempts: 3,
};
