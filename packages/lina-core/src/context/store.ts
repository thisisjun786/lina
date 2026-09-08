import type { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../protocol.ts";
import { openCheckedDatabase, validateBinding } from "../session-binding.ts";
import {
	captureSourceProofs,
	type SourceContextOptions,
	type SourceProof,
	sourceProofsCurrent,
} from "../source-policy.ts";
import { isOrdinaryArchiveEntry } from "./archive.ts";
import { ContextArtifacts } from "./artifacts.ts";
import { expandSource } from "./expansion.ts";
import {
	parseSummaryGeneration,
	type SummaryGeneration,
} from "./generation.ts";
import { initializeContextSchema } from "./schema.ts";
import { SummaryRecords } from "./summary-records.ts";
import type { ContextStoreOptions } from "./types.ts";
import {
	type ActivateInput,
	type ActiveSummary,
	type ExpandOptions,
	type ExpandPage,
	type LookupEntry,
	type SourceRef,
	type StageInput,
	SUMMARY_SOURCES_MAX,
	SUMMARY_TEXT_MAX_CHARS,
	type SummaryNode,
	type WorkingFields,
	type WorkingState,
} from "./types.ts";
import {
	fingerprintOf,
	sourceDeliveryGuard,
	unionProofs,
	validId,
	validRef,
} from "./validation.ts";
import {
	decodeWorkingRow,
	mergeWorkingFields,
	type WorkingRow,
} from "./working-state.ts";

interface ActiveRow {
	summary_id: string;
	native_entry_id: string;
	first_kept_entry_id: string;
	revision: number;
}

export class ContextStore {
	private readonly db: DatabaseSync;
	private readonly lookupEntry: LookupEntry;
	private closed = false;
	private readonly artifacts: ContextArtifacts;
	private readonly summaries: SummaryRecords;

	constructor(
		path: string,
		binding: BotBinding,
		lookupEntry: LookupEntry,
		options: ContextStoreOptions = {},
	) {
		if (typeof lookupEntry !== "function")
			throw new Error("invalid entry lookup");
		const identity = validateBinding(binding);
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		this.lookupEntry = lookupEntry;
		this.summaries = new SummaryRecords(this.db);
		this.artifacts = new ContextArtifacts(
			this.db,
			lookupEntry,
			identity.sessionId,
			options,
		);
		let transaction = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			transaction = true;
			initializeContextSchema(this.db, identity, opened.fresh);
			this.artifacts.validate();
			this.workingView({});
			this.summaries.validate();
			this.db.exec("COMMIT");
			transaction = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (transaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	stage(input: StageInput): SummaryNode {
		this.assertOpen();
		if (typeof input !== "object" || input === null)
			throw new Error("invalid stage input");
		if (input.kind !== "model" && input.kind !== "extractive")
			throw new Error("invalid summary kind");
		if (typeof input.text !== "string" || input.text.trim().length === 0)
			throw new Error("summary text must not be blank");
		if (input.text.length > SUMMARY_TEXT_MAX_CHARS)
			throw new Error(
				`summary text exceeds ${SUMMARY_TEXT_MAX_CHARS} characters`,
			);
		if (!Array.isArray(input.sources) || input.sources.length === 0)
			throw new Error("summary requires at least one source");
		if (input.sources.length > SUMMARY_SOURCES_MAX)
			throw new Error(`summary exceeds ${SUMMARY_SOURCES_MAX} sources`);
		const sources = input.sources.map(validRef);
		const keys = new Set(sources.map((ref) => `${ref.kind}:${ref.id}`));
		if (keys.size !== sources.length)
			throw new Error("summary sources must be unique");
		const canonical: StageInput = {
			...(input.generation !== undefined
				? { generation: parseSummaryGeneration(input.generation) }
				: {}),
			text: input.text,
			kind: input.kind,
			sources,
		};
		const sourceProofs = this.proofs(sources);
		const fingerprint = fingerprintOf(canonical, sourceProofs);
		const id = `summary-${fingerprint.slice(0, 32)}`;
		return this.transaction(() => {
			const existing = this.get(id);
			if (existing) return existing;
			// Only already-committed parents may be referenced, so the DAG stays acyclic.
			let depth = 0;
			for (const ref of sources) {
				if (ref.kind === "entry") {
					if (!this.lookupEntry(ref.id))
						throw new Error(`unknown source entry: ${ref.id}`);
					continue;
				}
				const parent = this.summaries.row(ref.id);
				if (!parent) throw new Error(`unknown source summary: ${ref.id}`);
				depth = Math.max(depth, parent.depth + 1);
			}
			if (!Number.isSafeInteger(depth))
				throw new Error("summary depth is not a safe integer");
			this.db
				.prepare(
					"INSERT INTO summaries (id, text, kind, depth, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					canonical.text,
					canonical.kind,
					depth,
					fingerprint,
					new Date().toISOString(),
				);
			const insert = this.db.prepare(
				"INSERT INTO summary_sources (summary_id, source_kind, source_id, ordinal) VALUES (?, ?, ?, ?)",
			);
			this.db
				.prepare("INSERT INTO summary_provenance VALUES (?, ?)")
				.run(id, JSON.stringify(sourceProofs));
			if (canonical.generation)
				this.db
					.prepare("INSERT INTO summary_generations VALUES (?,?)")
					.run(id, JSON.stringify(canonical.generation));
			sources.forEach((ref, ordinal) => {
				insert.run(id, ref.kind, ref.id, ordinal);
			});
			return {
				...(canonical.generation ? { generation: canonical.generation } : {}),
				id,
				text: canonical.text,
				kind: canonical.kind,
				depth,
				sources,
				fingerprint,
				sourceProofs,
			};
		});
	}

	findGenerated(
		sources: SourceRef[],
		raw: SummaryGeneration,
	): SummaryNode | undefined {
		this.assertOpen();
		const generation = parseSummaryGeneration(raw),
			refs = sources.map(validRef);
		const rows = this.db
			.prepare(
				"SELECT summary_id FROM summary_generations WHERE generation_json=? ORDER BY summary_id",
			)
			.all(JSON.stringify(generation));
		for (const row of rows) {
			const node = this.get(String(row["summary_id"]));
			if (
				node?.kind === "model" &&
				JSON.stringify(node.sources) === JSON.stringify(refs)
			)
				return node;
		}
		return undefined;
	}
	get(id: string): SummaryNode | undefined {
		const node = this.inspectSummary(id);
		return node && sourceProofsCurrent(node.sourceProofs, this.lookupEntry)
			? node
			: undefined;
	}

	/** Human inspection only; model consumers use get(). */
	inspectSummary(id: string): SummaryNode | undefined {
		this.assertOpen();
		return this.summaries.inspect(id);
	}

	active(): ActiveSummary | null {
		const active = this.activeReceipt();
		return active && this.get(active.id) ? active : null;
	}

	private activeReceipt(): ActiveSummary | null {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT * FROM active_summary WHERE id = 1")
			.get() as ActiveRow | undefined;
		return row
			? {
					id: row.summary_id,
					nativeEntryId: row.native_entry_id,
					firstKeptEntryId: row.first_kept_entry_id,
					revision: row.revision,
				}
			: null;
	}

	readActive() {
		const value = this.active();
		return {
			value,
			beforeDeliver: this.guardSources(
				value ? [{ kind: "summary", id: value.id }] : [],
			),
		};
	}

	activate(input: ActivateInput): ActiveSummary {
		this.assertOpen();
		if (typeof input !== "object" || input === null)
			throw new Error("invalid activate input");
		const id = validId(input.id, "summary id");
		const nativeEntryId = validId(input.nativeEntryId, "native entry id");
		const firstKeptEntryId = validId(
			input.firstKeptEntryId,
			"first kept entry id",
		);
		if (input.expectedActiveId !== null)
			validId(input.expectedActiveId, "expected active id");
		return this.transaction(() => {
			if (!this.get(id)) throw new Error(`unknown summary: ${id}`);
			const current = this.active();
			if (
				current &&
				current.id === id &&
				current.nativeEntryId === nativeEntryId &&
				current.firstKeptEntryId === firstKeptEntryId
			)
				return current;
			if (current?.id === id)
				throw new Error("active summary receipt conflict");
			if ((current?.id ?? null) !== input.expectedActiveId)
				throw new Error("stale active summary");
			const revision = (this.activeReceipt()?.revision ?? 0) + 1;
			this.db
				.prepare(
					`INSERT INTO active_summary (id, summary_id, native_entry_id, first_kept_entry_id, revision)
					VALUES (1, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET summary_id = excluded.summary_id,
						native_entry_id = excluded.native_entry_id,
						first_kept_entry_id = excluded.first_kept_entry_id,
						revision = excluded.revision`,
				)
				.run(id, nativeEntryId, firstKeptEntryId, revision);
			return { id, nativeEntryId, firstKeptEntryId, revision };
		});
	}

	working(options: SourceContextOptions = {}): WorkingState {
		this.recoverPending();
		return this.workingView(options);
	}

	private workingView(options: SourceContextOptions): WorkingState {
		const state = this.inspectWorking();
		const artifact = this.artifacts.get(`working-${state.revision}`);
		if (artifact && artifact.content !== JSON.stringify(state))
			throw Error("Working revision content mismatch");
		if (artifact && this.artifacts.eligible(artifact, options)) return state;
		return {
			revision: state.revision,
			goal: "",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		};
	}

	/** Use this pair across async model status/tool delivery boundaries. */
	readWorking(options: SourceContextOptions = {}) {
		const value = this.working(options);
		const id = `working-${value.revision}`;
		const artifact = this.artifacts.get(id);
		const beforeDeliver =
			artifact && this.artifacts.eligible(artifact, options)
				? this.artifacts.deliveryGuard(id, options)
				: () => {};
		return { value, beforeDeliver };
	}

	/** Human inspection only; this includes withheld legacy text. */
	inspectWorking(): WorkingState {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT * FROM working_state WHERE id = 1")
			.get() as WorkingRow | undefined;
		if (!row) throw new Error("corrupt context working state");
		return decodeWorkingRow(row);
	}

	updateWorking(
		expectedRevision: number,
		fields: WorkingFields,
		options: SourceContextOptions = {},
	): WorkingState {
		this.assertOpen();
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("invalid working revision");
		return this.transaction(() => {
			const current = this.inspectWorking();
			const next = mergeWorkingFields(current, fields, this.lookupEntry);
			if (current.revision !== expectedRevision)
				throw new Error("stale working revision");
			const revision = current.revision + 1;
			const fullReplacement = [
				"goal",
				"decisions",
				"openItems",
				"nextSteps",
			].every((key) => Object.hasOwn(fields, key));
			const hasText = [
				current.goal,
				...current.decisions,
				...current.openItems,
				...current.nextSteps,
			].some(Boolean);
			this.artifacts.create(
				`working-${revision}`,
				"working",
				JSON.stringify({ revision, ...next }),
				next.sourceEntryIds,
				options,
				fullReplacement
					? undefined
					: { id: `working-${current.revision}`, hasText },
			);
			this.db
				.prepare(
					`UPDATE working_state SET revision = ?, goal = ?, decisions = ?, open_items = ?,
					next_steps = ?, source_entry_ids = ? WHERE id = 1 AND revision = ?`,
				)
				.run(
					revision,
					next.goal,
					JSON.stringify(next.decisions),
					JSON.stringify(next.openItems),
					JSON.stringify(next.nextSteps),
					JSON.stringify(next.sourceEntryIds),
					expectedRevision,
				);
			return this.workingView(options);
		});
	}

	expand(ref: SourceRef, options: ExpandOptions = {}): ExpandPage {
		this.assertOpen();
		return expandSource(
			ref,
			options,
			(id) => this.eligibleEntry(id),
			(id) => this.get(id),
		);
	}

	/** Trusted current provenance, before summary selection or text budgeting. */
	eligibleEntry(id: string) {
		const source = this.lookupEntry(id);
		return isOrdinaryArchiveEntry(source) ? source : undefined;
	}

	proofs(sources: SourceRef[]): SourceProof[] {
		return unionProofs(
			...sources.map((ref) => {
				if (ref.kind === "summary") {
					const parent = this.get(ref.id);
					if (!parent) throw Error(`unknown source summary: ${ref.id}`);
					return parent.sourceProofs;
				}
				if (!this.eligibleEntry(ref.id))
					throw Error(`unknown source entry: ${ref.id}`);
				return captureSourceProofs([ref.id], this.lookupEntry);
			}),
		);
	}

	proofsCurrent(proofs: SourceProof[]): boolean {
		return sourceProofsCurrent(proofs, this.lookupEntry);
	}

	guardSources(sources: SourceRef[]): () => void {
		return sourceDeliveryGuard(this.proofs(sources), this.lookupEntry);
	}

	finalizeRequest(requestId: string): number {
		this.assertOpen();
		validId(requestId, "request id");
		return this.transaction(() => this.artifacts.finalizeRequest(requestId));
	}

	recoverPending(): number {
		this.assertOpen();
		return this.transaction(() => this.artifacts.finalizeRequest());
	}

	appendNote(callId: string, text: string, options: SourceContextOptions = {}) {
		this.assertOpen();
		this.recoverPending();
		return this.transaction(() =>
			this.artifacts.appendNote(callId, text, options),
		);
	}

	notes(limit?: number) {
		this.assertOpen();
		this.recoverPending();
		return this.artifacts.notes(limit);
	}

	readNotes(limit?: number) {
		const value = this.notes(limit);
		const guards = value.map((note) => this.artifacts.deliveryGuard(note.id));
		return {
			value,
			beforeDeliver: () => {
				for (const guard of guards) guard();
			},
		};
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("context store is closed");
	}

	private transaction<T>(action: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
