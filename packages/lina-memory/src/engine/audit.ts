import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { mergeSources } from "./records.ts";
import { ENGINE_BATCH_MAX, ENGINE_SOURCES_MAX } from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseObservations,
	parseRecord,
	revisionSchema,
} from "./validation.ts";

/** Refuse corrupt projections and unknown stored values before enabling writes. */
export function auditEngineData(db: DatabaseSync, current: number): void {
	if (db.prepare("SELECT count(*) AS n FROM engine_meta").get()?.["n"] !== 2)
		throw new Error("unknown engine metadata");
	for (const row of db
		.prepare("SELECT id, data FROM engine_records")
		.iterate()) {
		const record = parseRecord(JSON.parse(String(row["data"])));
		const sources = db
			.prepare(
				"SELECT entry_id, quote FROM engine_sources WHERE record_id = ? ORDER BY entry_id, quote LIMIT ?",
			)
			.all(record.id, ENGINE_SOURCES_MAX + 1)
			.map((source) => ({
				entryId: String(source["entry_id"]),
				quote: String(source["quote"]),
			}));
		if (!isDeepStrictEqual(mergeSources(sources), record.sources))
			throw new Error("invalid engine source projection");
		if (
			record.status !== "retracted" &&
			db
				.prepare(
					"SELECT 1 FROM engine_sources s JOIN engine_fences f ON f.entry_id = s.entry_id WHERE s.record_id = ? LIMIT 1",
				)
				.get(record.id)
		)
			throw new Error("active engine record cites invalidated source");
	}
	for (const row of db
		.prepare("SELECT entry_id, revision FROM engine_fences")
		.iterate()) {
		engineIdSchema.parse(row["entry_id"]);
		const revision = revisionSchema.parse(row["revision"]);
		if (revision < 1 || revision > current)
			throw new Error("invalid engine fence revision");
	}
	for (const row of db
		.prepare("SELECT record_id,entry_id,revision FROM engine_slot_fences")
		.iterate()) {
		engineIdSchema.parse(row["record_id"]);
		engineIdSchema.parse(row["entry_id"]);
		const revision = revisionSchema.parse(row["revision"]);
		if (revision < 1 || revision > current)
			throw Error("invalid slot fence revision");
	}

	for (const row of db
		.prepare("SELECT request_id, fingerprint, revision FROM engine_receipts")
		.iterate()) {
		const requestId = engineIdSchema.parse(row["request_id"]);
		const revision = revisionSchema.parse(row["revision"]);
		if (revision < 1 || revision > current)
			throw new Error("invalid engine receipt revision");
		const observations = db
			.prepare(
				"SELECT ordinal, data FROM engine_observations WHERE request_id = ? ORDER BY ordinal LIMIT ?",
			)
			.all(requestId, ENGINE_BATCH_MAX + 1);
		const parsed = parseObservations(
			observations.map((observation, index) => {
				if (observation["ordinal"] !== index)
					throw new Error("invalid engine observation ordinal");
				return JSON.parse(String(observation["data"]));
			}),
		);
		const fingerprint = hash({
			expectedRevision: revision - 1,
			observations: parsed.map((o) => ({
				...o,
				sources: mergeSources(o.sources),
			})),
		});
		if (row["fingerprint"] !== fingerprint)
			throw new Error("invalid engine receipt fingerprint");
	}
}
