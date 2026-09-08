import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { validateReasoningRecordReceipt } from "./reasoning-receipts.ts";
import { mergeSources } from "./records.ts";
import { ENGINE_BATCH_MAX, type EngineRecord } from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseObservations,
	parseProofs,
	recordId,
	revisionSchema,
} from "./validation.ts";

/** Receipt fingerprint commits both the original input and all consulted ancestry. */
export function readEngineReceipt(
	db: DatabaseSync,
	requestId: string,
	hasProofTable = true,
) {
	const row = db
		.prepare(
			"SELECT fingerprint,revision FROM engine_receipts WHERE request_id=?",
		)
		.get(engineIdSchema.parse(requestId));
	if (!row) return undefined;
	const revision = revisionSchema.parse(row["revision"]);
	if (revision < 1) throw Error("invalid engine receipt revision");
	const observations = parseObservations(
		db
			.prepare(
				"SELECT ordinal,data FROM engine_observations WHERE request_id=? ORDER BY ordinal LIMIT ?",
			)
			.all(requestId, ENGINE_BATCH_MAX + 1)
			.map((o, i) => {
				if (o["ordinal"] !== i)
					throw Error("invalid engine observation ordinal");
				return JSON.parse(String(o["data"]));
			}),
	);
	const proofRow = hasProofTable
		? db
				.prepare(
					"SELECT source_proofs,input_source_proofs FROM engine_request_sources WHERE request_id=?",
				)
				.get(requestId)
		: undefined;
	const proofs = proofRow
		? parseProofs(JSON.parse(String(proofRow["source_proofs"])))
		: undefined;
	const inputProofs = proofRow
		? parseProofs(JSON.parse(String(proofRow["input_source_proofs"])))
		: undefined;
	if (
		inputProofs?.some(
			(p) => !proofs?.some((other) => isDeepStrictEqual(other, p)),
		) ||
		(proofs &&
			observations.some((o) =>
				o.sources.some(
					(s) => !inputProofs?.some((p) => p.entryId === s.entryId),
				),
			))
	)
		throw Error("invalid engine receipt proof projection");
	const fingerprint = hash({
		expectedRevision: revision - 1,
		...(inputProofs
			? { inputSourceProofs: inputProofs, sourceProofs: proofs }
			: {}),
		observations: observations.map((o) => ({
			...o,
			sources: mergeSources(o.sources),
		})),
	});
	if (row["fingerprint"] !== fingerprint)
		throw Error("invalid engine receipt fingerprint");
	return { revision, fingerprint, observations, sourceProofs: proofs };
}

/** Missing linkage is preserved legacy data, never a qualified record. */
export function validateRecordReceipt(
	db: DatabaseSync,
	record: EngineRecord,
	seen = new Set<string>(),
): boolean {
	if (record.reasoning) return validateReasoningRecordReceipt(db, record, seen);
	if (!record.sourceRequestId) return false;
	const receipt = readEngineReceipt(db, record.sourceRequestId);
	if (
		!receipt?.sourceProofs ||
		!isDeepStrictEqual(receipt.sourceProofs, record.sourceProofs) ||
		receipt.revision > record.revision ||
		(record.status !== "retracted" && receipt.revision !== record.revision) ||
		!receipt.observations.some(
			(o) =>
				recordId(record.agentId, o) === record.id &&
				o.text === record.text &&
				o.evidence === record.evidence &&
				(record.status === "retracted" || o.status === record.status) &&
				o.sources.every((s) =>
					record.sources.some((r) => isDeepStrictEqual(s, r)),
				),
		)
	)
		throw Error("invalid engine record receipt proof binding");
	return true;
}
