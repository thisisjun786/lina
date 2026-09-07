import { createHash } from "node:crypto";
import { z } from "zod";
import {
	ENGINE_BATCH_MAX,
	ENGINE_SOURCES_MAX,
	ENGINE_TEXT_MAX,
	type EngineRecord,
	type LookupEntry,
	type Observation,
} from "./types.ts";

const nonblank = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine((s) => s.trim().length > 0, "blank text");
export const engineIdSchema = nonblank(256);
export const revisionSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER - 1);
const timeSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
const sourceSchema = z.strictObject({
	entryId: engineIdSchema,
	quote: nonblank(ENGINE_TEXT_MAX),
});
const fields = {
	subject: z.enum(["user", "self", "relationship"]),
	kind: z.enum([
		"fact",
		"interest",
		"preference",
		"concern",
		"mood",
		"attitude",
	]),
	key: z.string().regex(/^[a-z][a-z0-9._-]{0,95}$/),
	text: nonblank(ENGINE_TEXT_MAX),
	evidence: z.enum(["explicit", "inferred"]),
	sources: z.array(sourceSchema).min(1).max(ENGINE_SOURCES_MAX),
};
const observationSchema = z.strictObject({
	...fields,
	status: z.enum(["active", "resolved", "retracted"]).default("active"),
});
const recordSchema = z.strictObject({
	...fields,
	id: engineIdSchema,
	agentId: engineIdSchema,
	status: z.enum(["active", "resolved", "retracted"]),
	support: z.enum(["provisional", "supported"]),
	userSourceIds: z.array(engineIdSchema).max(ENGINE_SOURCES_MAX).optional(),
	generation: revisionSchema,
	revision: revisionSchema,
	createdAt: timeSchema,
	updatedAt: timeSchema,
	validFrom: timeSchema,
	expiresAt: timeSchema.nullable(),
	invalidatedAt: timeSchema.nullable(),
});
function validateFacet(value: Observation | EngineRecord): void {
	if (value.subject !== "user" && value.evidence !== "inferred")
		throw new Error("self/relationship evidence must be inferred");
	if (value.status === "resolved" && value.kind !== "concern")
		throw new Error("only concerns can be resolved");
}
export function parseObservations(value: unknown): Observation[] {
	const parsed = z.array(observationSchema).max(ENGINE_BATCH_MAX).parse(value);
	const slots = new Set<string>();
	for (const observation of parsed) {
		validateFacet(observation);
		if (
			observation.status === "retracted" &&
			(observation.subject !== "user" || observation.evidence !== "explicit")
		)
			throw Error("withdrawal requires explicit user evidence");
		const slot = JSON.stringify([
			observation.subject,
			observation.kind,
			observation.key,
		]);
		if (slots.has(slot)) throw new Error("duplicate observation slot");
		slots.add(slot);
	}
	return parsed;
}
export function parseApply(value: unknown) {
	const input = z
		.strictObject({
			requestId: engineIdSchema,
			expectedRevision: revisionSchema,
			observations: z.unknown(),
		})
		.parse(value);
	return { ...input, observations: parseObservations(input.observations) };
}
export function parseRecord(value: unknown): EngineRecord {
	const record = recordSchema.parse(value);
	validateFacet(record);
	const distinct = new Set(
		record.userSourceIds ?? record.sources.map((s) => s.entryId),
	).size;
	const expected =
		record.evidence === "explicit" || distinct >= 2
			? "supported"
			: "provisional";
	if (
		record.support !== expected ||
		(record.status === "resolved" && expected !== "supported")
	)
		throw new Error("invalid persisted support");
	if ((record.kind === "mood") !== (record.expiresAt !== null))
		throw new Error("invalid persisted expiry");
	if ((record.status === "retracted") !== (record.invalidatedAt !== null))
		throw new Error("invalid persisted invalidation");
	if (record.id !== recordId(record.agentId, record))
		throw new Error("invalid persisted record identity");
	return record;
}
/** Source lookup is supplied by the bound transcript owner, not by model output. */
export function validateSources(
	observations: Observation[],
	lookup: LookupEntry,
): void {
	for (const observation of observations) {
		let user = false;
		for (const source of observation.sources) {
			const entry = lookup(source.entryId);
			if (
				!entry ||
				entry.entryId !== source.entryId ||
				(entry.role !== "user" && entry.role !== "assistant")
			)
				throw new Error("invalid source entry or role");
			if (!entry.text.includes(source.quote))
				throw new Error("source quote does not match");
			user ||= entry.role === "user";
		}
		if (observation.evidence === "explicit" && !user)
			throw new Error("explicit evidence requires a user source");
	}
}
export function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function recordId(
	agentId: string,
	observation: Pick<Observation, "subject" | "kind" | "key">,
): string {
	return `memory-${hash([agentId, observation.subject, observation.kind, observation.key])}`;
}
export function validTime(now: () => number): number {
	return timeSchema.parse(now());
}
