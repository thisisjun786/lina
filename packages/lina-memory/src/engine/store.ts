import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import {
	openCheckedDatabase,
	validateBinding,
} from "../../../lina-core/src/session-binding.ts";
import type { SourceProof } from "../../../lina-core/src/source-policy.ts";
import {
	type ConsolidationClaim,
	type ConsolidationError,
	ConsolidationQueue,
	type ConsolidationSeed,
} from "./consolidation.ts";
import {
	eligibleRecord,
	mergeProofs,
	requireCurrentProofs,
} from "./provenance.ts";
import {
	contentHash,
	parseConclusions,
	prepareConclusions,
} from "./reasoning.ts";
import {
	parseReasoningInput,
	type ReasoningInput,
	readReasoningReceipt,
	withReasoningReadScope,
} from "./reasoning-receipts.ts";
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
			withReasoningReadScope(this.db, () =>
				initializeEngine(this.db, identity, opened.fresh),
			);
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
	/** Cheap delivery guard; does not expose or cache mutable records. */
	currentRevision(): number {
		this.assertOpen();
		return this.revision();
	}
	currentRecords(ids: readonly string[]): boolean {
		this.assertOpen();
		return ids.every((id) => {
			const record = this.get(engineIdSchema.parse(id));
			return !!record && this.reasoningEligible(record);
		});
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
		return this.transaction(() => {
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
				if (
					record.reasoning
						? !this.reasoningEligible(record)
						: !eligibleRecord(record, this.lookup)
				)
					continue;
				records.push(record);
				if (records.length === limit) break;
			}
			return records;
		}, false);
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
	beginReasoning(seed: ConsolidationSeed, recordIds: string[]) {
		this.assertOpen();
		return this.transaction(() => {
			const queue = new ConsolidationQueue(this.db, this.now);
			const job = queue.enqueue(seed);
			const claim = queue.claim(job.id);
			if (!claim) return undefined;
			const records = recordIds.map((id) => {
				const record = this.get(engineIdSchema.parse(id));
				if (!record || !this.reasoningEligible(record))
					throw Error("ineligible reasoning input");
				return record;
			});
			const input = parseReasoningInput({
				agentId: this.agentId,
				expectedRevision: this.revision(),
				policyRevision: seed.policyRevision,
				modelSettingsRevision: seed.modelSettingsRevision,
				stage: seed.stage,
				claimToken: claim.token,
				attempt: claim.attempt,
				records,
				promptProofs: mergeProofs(...records.map((r) => r.sourceProofs)),
				searches: [],
			});
			this.freezeReasoningInput(claim.id, input);
			return { claim, input };
		});
	}
	/** Host-only planning view; includes all eligible direct records without snapshot truncation. */
	reasoningCandidates(): EngineRecord[] {
		this.assertOpen();
		return this.transaction(
			() =>
				this.db
					.prepare("SELECT data FROM engine_records ORDER BY id")
					.all()
					.map((row) => this.decode(row["data"]))
					.filter((record) => this.reasoningEligible(record)),
			false,
		);
	}
	reasoningJobs() {
		this.assertOpen();
		const queue = new ConsolidationQueue(this.db, this.now);
		return this.db
			.prepare("SELECT id FROM engine_reasoning_jobs ORDER BY rowid")
			.all()
			.map((row) => queue.get(String(row["id"])))
			.filter((job) => job !== undefined);
	}
	enqueueReasoning(seed: ConsolidationSeed): void {
		this.assertOpen();
		this.transaction(() =>
			new ConsolidationQueue(this.db, this.now).enqueue(seed),
		);
	}
	recoverReasoning(): void {
		this.assertOpen();
		this.transaction(() =>
			new ConsolidationQueue(this.db, this.now).recover(
				(id) => readReasoningReceipt(this.db, id)?.revision,
			),
		);
	}
	supersedeReasoning(trigger: string): void {
		this.assertOpen();
		this.transaction(() =>
			new ConsolidationQueue(this.db, this.now).supersede(trigger),
		);
	}
	finishReasoning(claim: ConsolidationClaim, error: ConsolidationError): void {
		this.assertOpen();
		this.transaction(() =>
			new ConsolidationQueue(this.db, this.now).finish(
				claim,
				[
					"source_withheld",
					"configuration_changed",
					"search_budget_exhausted",
					"input_budget_insufficient",
					"character_growth_disabled",
				].includes(error)
					? "withheld"
					: "failed",
				null,
				error,
			),
		);
	}
	expandReasoning(
		claim: ConsolidationClaim,
		queries: string[],
		recordIds: string[],
	) {
		this.assertOpen();
		return this.transaction(() => {
			new ConsolidationQueue(this.db, this.now).assertClaim(claim);
			const row = this.db
				.prepare(
					"SELECT data FROM engine_reasoning_inputs WHERE request_id=? AND attempt=?",
				)
				.get(claim.id, claim.attempt);
			if (!row) throw Error("missing reasoning frozen input");
			const input = parseReasoningInput(JSON.parse(String(row["data"])));
			this.checkRevision(input.expectedRevision);
			const records = new Map(
				input.records.map((record) => [record.id, record]),
			);
			for (const id of recordIds) {
				const record = this.get(id);
				if (!record || !this.reasoningEligible(record))
					throw Error("ineligible reasoning search record");
				records.set(id, record);
			}
			const proofs = mergeProofs(
				input.promptProofs,
				...[...records.values()].map((record) => record.sourceProofs),
			);
			const next = parseReasoningInput({
				...input,
				records: [...records.values()],
				promptProofs: proofs,
				searches: [
					...input.searches,
					{ queries, recordIds, sourceProofs: proofs },
				],
			});
			for (const record of next.records)
				this.db
					.prepare(
						"INSERT OR IGNORE INTO engine_reasoning_history VALUES (?,?,?)",
					)
					.run(record.id, record.revision, JSON.stringify(record));
			this.db
				.prepare(
					"UPDATE engine_reasoning_inputs SET data=?,fingerprint=? WHERE request_id=? AND attempt=?",
				)
				.run(JSON.stringify(next), hash(next), claim.id, claim.attempt);
			return next;
		});
	}
	freezeReasoningPayload(
		claim: ConsolidationClaim,
		payload: string,
	): ReasoningInput {
		this.assertOpen();
		return this.transaction(() => {
			new ConsolidationQueue(this.db, this.now).assertClaim(claim);
			const row = this.db
				.prepare(
					"SELECT data FROM engine_reasoning_inputs WHERE request_id=? AND attempt=?",
				)
				.get(claim.id, claim.attempt);
			if (!row) throw Error("missing reasoning frozen input");
			const old = parseReasoningInput(JSON.parse(String(row["data"])));
			this.checkRevision(old.expectedRevision);
			requireCurrentProofs(old.promptProofs, this.lookup);
			const input = parseReasoningInput({
				...old,
				payloads: [...old.payloads, payload],
			});
			this.db
				.prepare(
					"UPDATE engine_reasoning_inputs SET data=?,fingerprint=? WHERE request_id=? AND attempt=?",
				)
				.run(JSON.stringify(input), hash(input), claim.id, claim.attempt);
			return input;
		});
	}
	applyConclusions(
		input: {
			requestId: string;
			expectedRevision: number;
			proposals: unknown;
			claim: ConsolidationClaim;
		},
		signal?: AbortSignal,
	): EngineSnapshot {
		this.assertOpen();
		signal?.throwIfAborted();
		const proposals = parseConclusions(input.proposals);
		if (input.requestId !== input.claim.id)
			throw Error("reasoning claim identity conflict");
		return this.transaction(() => {
			const replay = readReasoningReceipt(this.db, input.requestId);
			if (replay) {
				if (
					!isDeepStrictEqual(replay.output.proposals, proposals) ||
					replay.input.expectedRevision !== input.expectedRevision ||
					replay.input.claimToken !== input.claim.token
				)
					throw Error("reasoning receipt conflict");
				return this.read(false);
			}
			const queue = new ConsolidationQueue(this.db, this.now);
			queue.assertClaim(input.claim);
			const row = this.db
				.prepare(
					"SELECT data,fingerprint FROM engine_reasoning_inputs WHERE request_id=? AND attempt=?",
				)
				.get(input.requestId, input.claim.attempt);
			if (!row) throw Error("missing reasoning frozen input");
			const frozen = parseReasoningInput(JSON.parse(String(row["data"])));
			if (
				hash(frozen) !== row["fingerprint"] ||
				frozen.claimToken !== input.claim.token ||
				frozen.expectedRevision !== input.expectedRevision
			)
				throw Error("invalid reasoning frozen input");
			this.checkRevision(input.expectedRevision);
			const prepared = prepareConclusions({
				agentId: this.agentId,
				proposals,
				resolveAncestor: (id) => this.get(id),
				resolve: (id) => {
					const allowed = frozen.records.find((r) => r.id === id);
					return allowed ? this.get(id) : undefined;
				},
				promptProofs: frozen.promptProofs,
				lookup: this.lookup,
				now: validTime(this.now),
			});
			if (proposals.some((p) => p.reasoningKind !== frozen.stage))
				throw Error("reasoning stage mismatch");
			const revision = revisionSchema.parse(input.expectedRevision + 1),
				now = validTime(this.now);
			const records: EngineRecord[] = [];
			for (const item of prepared) {
				const id = recordId(this.agentId, item.proposal),
					previous = this.get(id);
				if (
					previous?.evidence === "explicit" &&
					this.reasoningEligible(previous)
				)
					continue;
				if (
					item.sourceProofs.some((p) => this.sourceInvalidated(p.entryId)) ||
					item.sources.some((source) =>
						this.db
							.prepare(
								"SELECT 1 FROM engine_slot_fences WHERE record_id=? AND entry_id=?",
							)
							.get(id, source.entryId),
					)
				)
					throw Error("invalidated conclusion evidence");
				const record: EngineRecord = {
					...deriveRecord(
						this.agentId,
						{
							subject: item.proposal.subject,
							kind: item.proposal.kind,
							key: item.proposal.key,
							text: item.proposal.text,
							evidence: "inferred",
							sources: item.sources,
						},
						undefined,
						revision,
						now,
						this.lookup,
					),
					generation: previous ? previous.generation + 1 : 0,
					createdAt: previous?.createdAt ?? now,
					sourceRequestId: input.requestId,
					sourceProofs: item.sourceProofs,
					reasoning: item.reasoning,
					support: item.support,
				};
				records.push(parseRecord(record));
			}
			signal?.throwIfAborted();
			requireCurrentProofs(frozen.promptProofs, this.lookup);
			this.checkRevision(input.expectedRevision);
			for (const record of records) {
				this.invalidateDescendants(record.id, revision, now);
				this.save(record);
				this.db
					.prepare("INSERT INTO engine_reasoning_history VALUES (?,?,?)")
					.run(record.id, record.revision, JSON.stringify(record));
				for (const premise of record.reasoning?.premises ?? []) {
					this.db
						.prepare("INSERT INTO engine_premises VALUES (?,?,?,?,?)")
						.run(
							record.id,
							record.revision,
							premise.recordId,
							premise.revision,
							premise.contentHash,
						);
				}
			}
			const output = { proposals, records };
			this.db
				.prepare("INSERT INTO engine_reasoning_receipts VALUES (?,?,?,?,?,?)")
				.run(
					input.requestId,
					hash({ input: frozen, output }),
					JSON.stringify(frozen),
					JSON.stringify(output),
					revision,
					records.length ? "changed" : "unchanged",
				);
			queue.finish(input.claim, "committed", revision);
			if (frozen.stage === "deduction")
				queue.enqueue({ ...input.claim.seed, stage: "induction" });
			this.setRevision(revision);
			return this.read(false);
		});
	}
	private freezeReasoningInput(requestId: string, input: ReasoningInput): void {
		for (const record of input.records) {
			const old = this.db
				.prepare(
					"SELECT data FROM engine_reasoning_history WHERE id=? AND revision=?",
				)
				.get(record.id, record.revision);
			if (
				old &&
				!isDeepStrictEqual(parseRecord(JSON.parse(String(old["data"]))), record)
			)
				throw Error("ambiguous legacy reasoning premise history");
			this.db
				.prepare(
					"INSERT OR IGNORE INTO engine_reasoning_history VALUES (?,?,?)",
				)
				.run(record.id, record.revision, JSON.stringify(record));
		}
		this.db
			.prepare("INSERT INTO engine_reasoning_inputs VALUES (?,?,?,?)")
			.run(requestId, input.attempt, hash(input), JSON.stringify(input));
	}
	private reasoningEligible(
		record: EngineRecord,
		visiting = new Set<string>(),
	): boolean {
		if (
			record.status !== "active" ||
			(record.expiresAt !== null && record.expiresAt <= validTime(this.now)) ||
			!eligibleRecord(record, this.lookup) ||
			visiting.has(record.id)
		)
			return false;
		visiting.add(record.id);
		for (const ref of record.reasoning?.premises ?? []) {
			const premise = this.get(ref.recordId);
			if (
				!premise ||
				contentHash(premise) !== ref.contentHash ||
				!this.reasoningEligible(premise, visiting)
			) {
				visiting.delete(record.id);
				return false;
			}
		}
		visiting.delete(record.id);
		return true;
	}
	private invalidateDescendants(
		id: string,
		revision: number,
		now: number,
	): void {
		const pending = [id],
			seen = new Set<string>([id]);
		while (pending.length) {
			const premise = pending.shift();
			for (const row of this.db
				.prepare(
					"SELECT DISTINCT conclusion_id FROM engine_premises WHERE premise_id=?",
				)
				.all(premise ?? "")) {
				const childId = String(row["conclusion_id"]);
				if (seen.has(childId)) continue;
				const child = this.get(childId);
				if (
					!child?.reasoning ||
					child.status === "retracted" ||
					!child.reasoning.premises.some((p) => p.recordId === premise)
				)
					continue;
				seen.add(childId);
				pending.push(childId);
				this.save({
					...child,
					status: "retracted",
					revision,
					generation: child.generation + 1,
					updatedAt: now,
					invalidatedAt: now,
				});
			}
		}
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
			this.invalidateDescendants(old.id, revision, now);
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
		if (record.reasoning) {
			for (const source of record.sources)
				this.db
					.prepare(
						"INSERT INTO engine_slot_fences VALUES (?,?,?) ON CONFLICT(record_id,entry_id) DO UPDATE SET revision=excluded.revision",
					)
					.run(record.id, source.entryId, revision);
			this.invalidateDescendants(record.id, revision, now);
			this.save({
				...record,
				status: "retracted",
				revision,
				generation: record.generation + 1,
				updatedAt: now,
				invalidatedAt: now,
			});
			return;
		}
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
			this.invalidateDescendants(id, revision, now);
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
				"INSERT OR IGNORE INTO engine_record_history SELECT id,json_extract(data, '$.revision'),data FROM engine_records WHERE id=? AND json_extract(data, '$.revision')<>?",
			)
			.run(record.id, record.revision);
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
		if (!record.reasoning)
			this.db
				.prepare(
					"UPDATE engine_reasoning_checkpoint SET dirty_revision=? WHERE id=1",
				)
				.run(record.revision);
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
				if (
					record.reasoning
						? !this.reasoningEligible(record)
						: !eligibleRecord(record, this.lookup)
				)
					continue;
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
		if (this.db.isTransaction) {
			if(write)throw Error("reentrant engine mutation");
			return action();
		}
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const value = withReasoningReadScope(this.db, action);
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
