import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import {
	openCheckedDatabase,
	validateBinding,
} from "../../../lina-core/src/session-binding.ts";
import type { SourceProof } from "../../../lina-core/src/source-policy.ts";
import {
	eligibleRecord,
	mergeProofs,
	requireCurrentProofs,
} from "./provenance.ts";
import { readEngineReceipt, validateRecordReceipt } from "./receipts.ts";
import { deriveRecord, mergeSources, sameValue } from "./records.ts";
import { initializeEngine } from "./schema.ts";
import {
	type ApplyInput,
	ENGINE_READ_MAX,
	type EngineOptions,
	type EngineRecord,
	type EngineSnapshot,
	type EngineState,
	type Observation,
} from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseApply,
	parseProofs,
	parseRecord,
	recordId,
	revisionSchema,
	validateSources,
	validTime,
} from "./validation.ts";

/** One checked SQLite file belongs to one immutable BotBinding. All methods are synchronous. */
export class EngineStore {
	readonly agentId: string;
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private readonly lookup: EngineOptions["lookup"];
	private readonly sequence: EngineOptions["sourceSequence"];
	private closed = false;
	constructor(path: string, binding: BotBinding, options: EngineOptions) {
		const identity = validateBinding(binding);
		if (typeof options.lookup !== "function")
			throw new Error("invalid engine lookup");
		this.now = options.now ?? Date.now;
		validTime(this.now);
		this.lookup = options.lookup;
		this.sequence = options.sourceSequence;
		this.agentId = engineIdSchema.parse(identity.botId);
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			initializeEngine(this.db, identity, opened.fresh);
			this.db.exec("COMMIT");
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}
	recordCount(): number {
		this.assertOpen();
		return Number(
			this.db
				.prepare("SELECT count(*) n FROM engine_records WHERE agent_id=?")
				.get(this.agentId)?.["n"],
		);
	}

	snapshot(): EngineSnapshot {
		return this.read(false);
	}
	state(): EngineState {
		return this.read(true);
	}
	sourceInvalidated(entryId: string): boolean {
		this.assertOpen();
		engineIdSchema.parse(entryId);
		return (
			this.db
				.prepare("SELECT 1 FROM engine_fences WHERE entry_id=?")
				.get(entryId) !== undefined
		);
	}
	/** Committed processing receipt, including empty deltas and later retractions. */
	hasReceipt(requestId: string): boolean {
		this.assertOpen();
		engineIdSchema.parse(requestId);
		try {
			const receipt = readEngineReceipt(this.db, requestId);
			if (!receipt?.sourceProofs) return false;
			requireCurrentProofs(receipt.sourceProofs, this.lookup);
			return true;
		} catch {
			return false;
		}
	}

	/** Historical commit exists but is not reusable as current model evidence. */
	receiptWithheld(requestId: string): boolean {
		this.assertOpen();
		engineIdSchema.parse(requestId);
		return (
			!!this.db
				.prepare("SELECT 1 FROM engine_receipts WHERE request_id=?")
				.get(requestId) && !this.hasReceipt(requestId)
		);
	}
	recall(query: string, options: { limit?: number } = {}): EngineRecord[] {
		this.assertOpen();
		if (typeof query !== "string" || query.length > 2000)
			throw new Error("invalid recall query");
		const requested = options.limit ?? 20;
		if (!Number.isSafeInteger(requested) || requested < 0)
			throw new Error("invalid recall limit");
		const now = validTime(this.now);
		const records: EngineRecord[] = [];
		const limit = Math.min(requested, ENGINE_READ_MAX);
		if (!limit) return records;
		for (const row of this.db
			.prepare(
				"SELECT data FROM engine_records WHERE agent_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) AND (instr(lower(json_extract(data, '$.text')), lower(?)) > 0 OR instr(lower(json_extract(data, '$.key')), lower(?)) > 0) ORDER BY updated_at DESC, id",
			)
			.iterate(this.agentId, now, query.trim(), query.trim())) {
			const record = this.decode(row["data"]);
			if (!eligibleRecord(record, this.lookup)) continue;
			records.push(record);
			if (records.length === limit) break;
		}
		return records;
	}
	apply(input: ApplyInput, signal?: AbortSignal): EngineSnapshot {
		this.assertOpen();
		signal?.throwIfAborted();
		const parsed = parseApply(input);
		requireCurrentProofs(parsed.sourceProofs, this.lookup);
		if (
			!parsed.sourceProofs.some(
				(proof) => this.lookup(proof.entryId)?.role === "user",
			)
		)
			throw Error("engine observation requires a user episode");
		if (
			parsed.observations.some((o) =>
				o.sources.some(
					(s) => !parsed.sourceProofs.some((p) => p.entryId === s.entryId),
				),
			)
		)
			throw Error("observation outside source proofs");
		const fingerprintFor = (sourceProofs: SourceProof[]) =>
			hash({
				expectedRevision: parsed.expectedRevision,
				inputSourceProofs: parsed.sourceProofs,
				sourceProofs,
				observations: parsed.observations.map((o) => ({
					...o,
					sources: mergeSources(o.sources),
				})),
			});
		const saved = this.db
			.prepare(
				"SELECT source_proofs FROM engine_request_sources WHERE request_id=?",
			)
			.get(parsed.requestId);
		if (
			saved &&
			this.receipt(
				parsed.requestId,
				fingerprintFor(parseProofs(JSON.parse(String(saved["source_proofs"])))),
			)
		)
			return this.snapshot();
		this.checkRevision(parsed.expectedRevision);
		// Call untrusted/injected lookup outside the write transaction. Recheck the
		// generation afterwards so a reentrant retraction cannot be overwritten.
		validateSources(parsed.observations, this.lookup);
		// Store both the exact input for replay and every prior used by ranking/merge.
		const consultedProofs = mergeProofs(
			parsed.sourceProofs,
			...parsed.observations.flatMap((candidate) => {
				const previous = this.get(recordId(this.agentId, candidate));
				return previous && eligibleRecord(previous, this.lookup)
					? [previous.sourceProofs]
					: [];
			}),
		);
		requireCurrentProofs(consultedProofs, this.lookup);
		const fingerprint = fingerprintFor(consultedProofs);
		signal?.throwIfAborted();
		const now = validTime(this.now);
		this.transaction(() => {
			if (this.receipt(parsed.requestId, fingerprint)) return;
			this.checkRevision(parsed.expectedRevision);
			const revision = parsed.expectedRevision + 1;
			this.db
				.prepare("INSERT INTO engine_receipts VALUES (?, ?, ?)")
				.run(parsed.requestId, fingerprint, revision);
			this.db
				.prepare("INSERT INTO engine_request_sources VALUES (?,?,?)")
				.run(
					parsed.requestId,
					JSON.stringify(consultedProofs),
					JSON.stringify(parsed.sourceProofs),
				);
			const insert = this.db.prepare(
				"INSERT INTO engine_observations VALUES (?, ?, ?)",
			);
			parsed.observations.forEach((candidate, ordinal) => {
				insert.run(parsed.requestId, ordinal, JSON.stringify(candidate));
			});
			for (const candidate of parsed.observations)
				this.applyOne(
					candidate,
					revision,
					now,
					consultedProofs,
					parsed.requestId,
				);
			signal?.throwIfAborted();
			requireCurrentProofs(consultedProofs, this.lookup);
			this.setRevision(revision);
		});
		return this.snapshot();
	}
	retract(id: string, expectedRevision: number): EngineSnapshot {
		this.assertOpen();
		engineIdSchema.parse(id);
		revisionSchema.parse(expectedRevision);
		const now = validTime(this.now);
		this.transaction(() => {
			this.checkRevision(expectedRevision);
			const record = this.get(id);
			if (!record) throw new Error("unknown bound engine record");
			if (record.status === "retracted") return;
			this.invalidate(record, expectedRevision + 1, now);
			this.setRevision(expectedRevision + 1);
		});
		return this.snapshot();
	}
	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}
	private applyOne(
		candidate: Observation,
		revision: number,
		now: number,
		proofs: SourceProof[],
		requestId: string,
	): void {
		for (const source of candidate.sources) {
			if (
				this.db
					.prepare("SELECT revision FROM engine_fences WHERE entry_id = ?")
					.get(source.entryId)
			)
				throw new Error("invalidated source evidence");
		}
		const slot = recordId(this.agentId, candidate);
		if (
			candidate.sources.some((s) =>
				this.db
					.prepare(
						"SELECT 1 FROM engine_slot_fences WHERE record_id=? AND entry_id=?",
					)
					.get(slot, s.entryId),
			)
		)
			throw Error("invalidated slot evidence");
		const previous = this.get(recordId(this.agentId, candidate));
		const old =
			previous && eligibleRecord(previous, this.lookup) ? previous : undefined;
		// Explicit user statements outrank later model interpretation. The processing
		// receipt still records this ignored proposal without changing the memory.
		if (old?.evidence === "explicit" && candidate.evidence === "inferred")
			return;
		if (old && this.sequence) {
			const latest = (sources: Observation["sources"]) =>
				Math.max(
					0,
					...sources
						.filter((s) => this.lookup(s.entryId)?.role === "user")
						.map((s) => this.sequence?.(s.entryId) ?? 0),
				);
			if (latest(candidate.sources) < latest(old.sources)) return;
		}
		const same = old && sameValue(old, candidate);
		// A processing receipt is new work; identical evidence is not a new premise.
		// Preserve the original receipt binding and ranking until content or provenance changes.
		if (
			same &&
			isDeepStrictEqual(
				old.sources,
				mergeSources([...old.sources, ...candidate.sources]),
			) &&
			isDeepStrictEqual(old.sourceProofs, mergeProofs(proofs, old.sourceProofs))
		)
			return;
		if (old && !same) {
			// A correction must carry fresh evidence, not reinterpret any old citation.
			if (
				candidate.sources.some((s) =>
					old.sources.some((previous) => previous.entryId === s.entryId),
				)
			)
				throw new Error("invalidated correction evidence");
			if (candidate.status === "retracted") this.invalidate(old, revision, now);
			else
				for (const source of old.sources)
					this.db
						.prepare(
							"INSERT INTO engine_slot_fences VALUES (?,?,?) ON CONFLICT(record_id,entry_id) DO UPDATE SET revision=excluded.revision",
						)
						.run(old.id, source.entryId, revision);
		}
		this.save({
			...deriveRecord(this.agentId, candidate, old, revision, now, this.lookup),
			sourceProofs: mergeProofs(proofs, same ? old?.sourceProofs : undefined),
			sourceRequestId: requestId,
		});
	}
	private invalidate(
		record: EngineRecord,
		revision: number,
		now: number,
	): void {
		const affected = new Set<string>([record.id]);
		for (const source of record.sources) {
			this.db
				.prepare(
					"INSERT INTO engine_fences VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET revision = excluded.revision",
				)
				.run(source.entryId, revision);
			for (const row of this.db
				.prepare("SELECT record_id FROM engine_sources WHERE entry_id = ?")
				.iterate(source.entryId))
				affected.add(String(row["record_id"]));
		}
		for (const id of affected) {
			const dependent = this.get(id);
			if (dependent && dependent.status !== "retracted")
				this.save({
					...dependent,
					status: "retracted",
					revision,
					generation: dependent.generation + 1,
					invalidatedAt: now,
					updatedAt: now,
				});
		}
	}
	private save(record: EngineRecord): void {
		parseRecord(record);
		if (record.sourceProofs && record.status !== "retracted")
			requireCurrentProofs(record.sourceProofs, this.lookup);
		this.db
			.prepare(
				"INSERT OR IGNORE INTO engine_record_history SELECT id,json_extract(data, '$.revision'),data FROM engine_records WHERE id=?",
			)
			.run(record.id);
		this.db
			.prepare(
				"INSERT INTO engine_records VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at, updated_at=excluded.updated_at, data=excluded.data",
			)
			.run(
				record.id,
				this.agentId,
				record.status,
				record.expiresAt,
				record.updatedAt,
				JSON.stringify(record),
			);
		this.db
			.prepare("DELETE FROM engine_sources WHERE record_id = ?")
			.run(record.id);
		const insert = this.db.prepare(
			"INSERT INTO engine_sources VALUES (?, ?, ?)",
		);
		for (const source of record.sources)
			insert.run(record.id, source.entryId, source.quote);
	}
	private read(active: boolean): EngineSnapshot {
		this.assertOpen();
		const now = validTime(this.now);
		return this.transaction(() => {
			const rows: EngineRecord[] = [];
			const query = active
				? this.db
						.prepare(
							"SELECT data FROM engine_records WHERE agent_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,id",
						)
						.iterate(this.agentId, now)
				: this.db
						.prepare(
							"SELECT data FROM engine_records WHERE agent_id=? ORDER BY updated_at DESC,id",
						)
						.iterate(this.agentId);
			for (const row of query) {
				const record = this.decode(row["data"]);
				if (!eligibleRecord(record, this.lookup)) continue;
				rows.push(record);
				if (rows.length > ENGINE_READ_MAX) break;
			}
			return {
				agentId: this.agentId,
				revision: this.revision(),
				asOf: now,
				records: rows.slice(0, ENGINE_READ_MAX),
				truncated: rows.length > ENGINE_READ_MAX,
			};
		}, false);
	}
	private get(id: string): EngineRecord | undefined {
		const row = this.db
			.prepare("SELECT data FROM engine_records WHERE id = ? AND agent_id = ?")
			.get(id, this.agentId);
		return row ? this.decode(row["data"]) : undefined;
	}
	private decode(data: unknown): EngineRecord {
		if (typeof data !== "string")
			throw new Error("invalid persisted engine record");
		const record = parseRecord(JSON.parse(data));
		if (record.agentId !== this.agentId)
			throw new Error("foreign engine record binding");
		validateRecordReceipt(this.db, record);
		return record;
	}
	private receipt(requestId: string, fingerprint: string): boolean {
		const row = this.db
			.prepare("SELECT fingerprint FROM engine_receipts WHERE request_id = ?")
			.get(requestId);
		if (row && row["fingerprint"] !== fingerprint)
			throw new Error("receipt requestId conflict");
		if (row && !this.hasReceipt(requestId))
			throw Error("ineligible or stale engine receipt");
		return row !== undefined;
	}
	private revision(): number {
		const value = this.db
			.prepare("SELECT value FROM engine_meta WHERE key = 'revision'")
			.get()?.["value"];
		if (typeof value !== "string") throw new Error("missing engine revision");
		return revisionSchema.parse(JSON.parse(value));
	}
	private checkRevision(expected: number): void {
		if (this.revision() !== expected) throw new Error("stale engine revision");
	}
	private setRevision(revision: number): void {
		this.db
			.prepare("UPDATE engine_meta SET value = ? WHERE key = 'revision'")
			.run(String(revision));
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("engine store is closed");
	}
	private transaction<T>(action: () => T, write = true): T {
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const value = action();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
