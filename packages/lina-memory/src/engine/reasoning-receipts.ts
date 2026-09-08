import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { mergeProofs } from "./provenance.ts";
import {
	conclusionSources,
	contentHash,
	parseConclusions,
} from "./reasoning.ts";
import { validateRecordReceipt } from "./receipts.ts";
import {
	ENGINE_BATCH_MAX,
	ENGINE_READ_MAX,
	type EngineRecord,
} from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseProofs,
	parseRecord,
	recordId,
	revisionSchema,
} from "./validation.ts";

const inputSchema = z.strictObject({
	agentId: engineIdSchema,
	expectedRevision: revisionSchema,
	policyRevision: revisionSchema,
	modelSettingsRevision: revisionSchema,
	stage: z.enum(["deduction", "induction"]),
	claimToken: engineIdSchema,
	attempt: z.number().int().min(1).max(3),
	records: z.array(z.unknown()).max(ENGINE_READ_MAX),
	promptProofs: z.unknown(),
	payloads: z.array(z.string().min(1).max(32000)).max(9).default([]),
	searches: z
		.array(
			z.strictObject({
				queries: z.array(z.string().min(1).max(512)).max(3),
				recordIds: z.array(engineIdSchema).max(ENGINE_READ_MAX),
				sourceProofs: z.unknown(),
			}),
		)
		.max(8),
});
export function parseReasoningInput(value: unknown) {
	const parsed = inputSchema.parse(value);
	const records = parsed.records.map(parseRecord);
	if (
		new Set(records.map((r) => r.id)).size !== records.length ||
		records.some(
			(r) =>
				r.agentId !== parsed.agentId ||
				r.status !== "active" ||
				r.revision > parsed.expectedRevision,
		)
	)
		throw Error("invalid reasoning input records");
	const promptProofs = parseProofs(parsed.promptProofs);
	if (
		!isDeepStrictEqual(
			mergeProofs(promptProofs, ...records.map((r) => r.sourceProofs)),
			promptProofs,
		)
	)
		throw Error("incomplete reasoning prompt provenance");
	const searches = parsed.searches.map((s) => ({
		...s,
		sourceProofs: parseProofs(s.sourceProofs),
	}));
	if (
		searches.some(
			(s) =>
				s.recordIds.some((id) => !records.some((r) => r.id === id)) ||
				s.sourceProofs.some(
					(p) => !promptProofs.some((other) => isDeepStrictEqual(other, p)),
				),
		)
	)
		throw Error("invalid reasoning search provenance");
	return { ...parsed, records, promptProofs, searches };
}
export type ReasoningInput = ReturnType<typeof parseReasoningInput>;

/** Historical evidence is verified structurally here; current source permissions are a read/commit guard. */
export function readReasoningReceipt(
	db: DatabaseSync,
	requestId: string,
	seen = new Set<string>(),
) {
	const row = db
		.prepare("SELECT * FROM engine_reasoning_receipts WHERE request_id=?")
		.get(engineIdSchema.parse(requestId));
	if (!row) return undefined;
	if (seen.has(requestId)) throw Error("reasoning receipt cycle");
	seen.add(requestId);
	try {
		const input = parseReasoningInput(JSON.parse(String(row["input_json"])));
		const raw = z
			.strictObject({
				proposals: z.unknown(),
				records: z.array(z.unknown()).max(ENGINE_BATCH_MAX),
			})
			.parse(JSON.parse(String(row["output_json"])));
		const output = {
			proposals: parseConclusions(raw.proposals),
			records: raw.records.map(parseRecord),
		};
		const revision = revisionSchema.parse(row["revision"]);
		const fingerprint = hash({ input, output });
		const frozen = db
			.prepare(
				"SELECT data,fingerprint FROM engine_reasoning_inputs WHERE request_id=? AND attempt=?",
			)
			.get(requestId, input.attempt);
		if (
			!frozen ||
			frozen["fingerprint"] !== hash(input) ||
			!isDeepStrictEqual(
				parseReasoningInput(JSON.parse(String(frozen["data"]))),
				input,
			)
		)
			throw Error("reasoning receipt differs from frozen input");
		if (
			revision !== input.expectedRevision + 1 ||
			row["fingerprint"] !== fingerprint ||
			row["outcome"] !== (output.records.length ? "changed" : "unchanged") ||
			new Set(output.records.map((r) => r.id)).size !== output.records.length
		)
			throw Error("invalid reasoning receipt fingerprint or revision");
		const job = db
			.prepare(
				"SELECT seed,attempts,state,claim_token,result_revision FROM engine_reasoning_jobs WHERE id=?",
			)
			.get(requestId);
		if (!job) throw Error("missing reasoning job");
		const seed = JSON.parse(String(job["seed"]));
		if (
			seed.policyRevision !== input.policyRevision ||
			seed.modelSettingsRevision !== input.modelSettingsRevision ||
			seed.stage !== input.stage ||
			job["attempts"] !== input.attempt ||
			(job["state"] !== "running" && job["state"] !== "committed") ||
			(job["state"] === "running" && job["claim_token"] !== input.claimToken) ||
			(job["state"] === "committed" && job["result_revision"] !== revision)
		)
			throw Error("invalid reasoning receipt claim binding");
		for (const record of input.records) {
			const archived = db
				.prepare(
					"SELECT data FROM engine_record_history WHERE id=? AND revision=?",
				)
				.get(record.id, record.revision);
			const current = db
				.prepare("SELECT data FROM engine_records WHERE id=?")
				.get(record.id);
			if (
				![archived, current].some(
					(r) =>
						r &&
						isDeepStrictEqual(
							parseRecord(JSON.parse(String(r["data"]))),
							record,
						),
				)
			)
				throw Error("missing reasoning input history");
			if (!validateRecordReceipt(db, record, seen))
				throw Error("unqualified reasoning input record");
		}
		for (const record of output.records) {
			const proposal = output.proposals.find(
				(p) => recordId(input.agentId, p) === record.id,
			);
			if (!proposal || proposal.reasoningKind !== input.stage)
				throw Error("invalid reasoning output proposal");
			const premises = proposal.premises.map((ref) => {
				const p = input.records.find(
					(r) => r.id === ref.recordId && r.revision === ref.revision,
				);
				if (!p) throw Error("missing reasoning output premise");
				return p;
			});
			const reasoning = {
				kind: proposal.reasoningKind,
				premises: premises.map((p) => ({
					recordId: p.id,
					revision: p.revision,
					contentHash: contentHash(p),
				})),
			};
			const support =
				proposal.reasoningKind === "deduction" &&
				premises.every(
					(p) =>
						p.support === "supported" &&
						(p.evidence === "explicit" || p.reasoning?.kind === "deduction"),
				)
					? "supported"
					: "provisional";
			const sources = conclusionSources(premises);
			const userSourceIds = [
				...new Set(
					premises
						.flatMap((p) => p.userSourceIds ?? [])
						.filter((id) => sources.some((source) => source.entryId === id)),
				),
			].sort();
			if (
				record.agentId !== input.agentId ||
				record.revision !== revision ||
				record.sourceRequestId !== requestId ||
				record.status !== "active" ||
				record.text !== proposal.text ||
				record.evidence !== "inferred" ||
				record.support !== support ||
				!isDeepStrictEqual(record.reasoning, reasoning) ||
				!isDeepStrictEqual(record.sources, sources) ||
				!isDeepStrictEqual(
					record.sourceProofs,
					mergeProofs(
						input.promptProofs,
						...premises.map((p) => p.sourceProofs),
					),
				) ||
				!isDeepStrictEqual(
					[...(record.userSourceIds ?? [])].sort(),
					userSourceIds,
				)
			)
				throw Error("invalid reasoning output projection");
		}
		return { input, output, revision, fingerprint };
	} finally {
		seen.delete(requestId);
	}
}

export function validateReasoningRecordReceipt(
	db: DatabaseSync,
	record: EngineRecord,
	seen = new Set<string>(),
): boolean {
	if (!record.reasoning || !record.sourceRequestId) return false;
	const receipt = readReasoningReceipt(db, record.sourceRequestId, seen);
	const original = receipt?.output.records.find((r) => r.id === record.id);
	if (
		!original ||
		original.revision > record.revision ||
		(record.status !== "retracted" && !isDeepStrictEqual(original, record)) ||
		(record.status === "retracted" &&
			![
				"text",
				"evidence",
				"sourceProofs",
				"sources",
				"reasoning",
				"support",
				"userSourceIds",
			].every((key) =>
				isDeepStrictEqual(
					original[key as keyof EngineRecord],
					record[key as keyof EngineRecord],
				),
			))
	)
		throw Error("invalid reasoning record receipt binding");
	return true;
}
