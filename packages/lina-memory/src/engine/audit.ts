import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	parseReasoningInput,
	readReasoningReceipt,
} from "./reasoning-receipts.ts";
import { readEngineReceipt, validateRecordReceipt } from "./receipts.ts";
import { mergeSources } from "./records.ts";
import { ENGINE_SOURCES_MAX } from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseRecord,
	revisionSchema,
} from "./validation.ts";

/** Refuse corrupt projections and unknown stored values before enabling writes. */
export function auditEngineData(
	db: DatabaseSync,
	current: number,
	version: number,
	agentId: string,
): void {
	const migrationRevision =
		version >= 4
			? revisionSchema.parse(
					JSON.parse(
						String(
							db
								.prepare(
									"SELECT value FROM engine_meta WHERE key='reasoning_migration_revision'",
								)
								.get()?.["value"],
						),
					),
				)
			: 0;
	if (
		db.prepare("SELECT count(*) AS n FROM engine_meta").get()?.["n"] !==
		(version >= 4 ? 3 : 2)
	)
		throw new Error("unknown engine metadata");
	for (const row of db
		.prepare("SELECT id, data FROM engine_records")
		.iterate()) {
		const record = parseRecord(JSON.parse(String(row["data"])));
		if (version < 4 && record.reasoning)
			throw Error("unexpected legacy reasoning metadata");
		if (version < 3 && (record.sourceProofs || record.sourceRequestId))
			throw Error("unexpected legacy engine proof");
		if (version >= 3) validateRecordReceipt(db, record);
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
	for (const row of version === 1
		? []
		: db
				.prepare("SELECT record_id,entry_id,revision FROM engine_slot_fences")
				.iterate()) {
		engineIdSchema.parse(row["record_id"]);
		engineIdSchema.parse(row["entry_id"]);
		const revision = revisionSchema.parse(row["revision"]);
		if (revision < 1 || revision > current)
			throw Error("invalid slot fence revision");
	}

	if (version >= 3)
		for (const row of db
			.prepare("SELECT id,revision,data FROM engine_record_history")
			.iterate()) {
			const record = parseRecord(JSON.parse(String(row["data"])));
			if (version < 4 && record.reasoning)
				throw Error("unexpected legacy reasoning metadata");
			if (
				record.id !== row["id"] ||
				record.agentId !== agentId ||
				record.revision !== row["revision"] ||
				record.revision > current
			)
				throw Error("invalid engine record history");
			validateRecordReceipt(db, record);
			if (version >= 4 && record.revision > migrationRevision) {
				const currentRow = db
					.prepare("SELECT data FROM engine_records WHERE id=?")
					.get(record.id);
				if (currentRow) {
					const currentRecord = parseRecord(
						JSON.parse(String(currentRow["data"])),
					);
					if (
						currentRecord.revision === record.revision &&
						!isDeepStrictEqual(currentRecord, record)
					)
						throw Error("reasoning history/current revision mismatch");
				}
			}
		}

	for (const row of db
		.prepare("SELECT request_id FROM engine_receipts")
		.iterate()) {
		const receipt = readEngineReceipt(
			db,
			String(row["request_id"]),
			version >= 3,
		);
		if (!receipt || receipt.revision > current)
			throw Error("invalid engine receipt revision");
	}
	if (version >= 4) {
		for (const row of db
			.prepare("SELECT * FROM engine_reasoning_history")
			.iterate()) {
			const record = parseRecord(JSON.parse(String(row["data"])));
			if (
				record.id !== row["id"] ||
				record.revision !== row["revision"] ||
				record.agentId !== agentId ||
				record.revision > current ||
				!validateRecordReceipt(db, record)
			)
				throw Error("invalid reasoning premise history");
		}
		for (const row of db
			.prepare("SELECT * FROM engine_reasoning_inputs")
			.iterate()) {
			const input = parseReasoningInput(JSON.parse(String(row["data"])));
			if (
				input.agentId !== agentId ||
				input.expectedRevision > current ||
				input.attempt !== row["attempt"] ||
				hash(input) !== row["fingerprint"]
			)
				throw Error("invalid frozen reasoning input");
		}
		let expectedEdges = 0;
		for (const row of db
			.prepare("SELECT request_id FROM engine_reasoning_receipts")
			.iterate()) {
			const receipt = readReasoningReceipt(db, String(row["request_id"]));
			if (
				!receipt ||
				receipt.revision > current ||
				receipt.input.agentId !== agentId
			)
				throw Error("invalid reasoning receipt revision or binding");
			for (const record of receipt.output.records) {
				const edges = db
					.prepare(
						"SELECT premise_id,premise_revision,content_hash FROM engine_premises WHERE conclusion_id=? AND conclusion_revision=? ORDER BY premise_id",
					)
					.all(record.id, record.revision);
				const expected = (record.reasoning?.premises ?? [])
					.map((p) => ({
						premise_id: p.recordId,
						premise_revision: p.revision,
						content_hash: p.contentHash,
					}))
					.sort((a, b) => a.premise_id.localeCompare(b.premise_id));
				if (
					!isDeepStrictEqual(
						edges.map((e) => ({ ...e })),
						expected,
					)
				)
					throw Error("invalid reasoning edge projection");
				expectedEdges += expected.length;
			}
		}
		if (
			db.prepare("SELECT count(*) AS n FROM engine_premises").get()?.["n"] !==
			expectedEdges
		)
			throw Error("orphan reasoning edge");
		for (const job of db
			.prepare(
				"SELECT id,result_revision FROM engine_reasoning_jobs WHERE state='committed'",
			)
			.iterate()) {
			const receipt = db
				.prepare(
					"SELECT revision FROM engine_reasoning_receipts WHERE request_id=?",
				)
				.get(String(job["id"]));
			if (!receipt || receipt["revision"] !== job["result_revision"])
				throw Error("missing reasoning completion receipt");
		}
	}
}
