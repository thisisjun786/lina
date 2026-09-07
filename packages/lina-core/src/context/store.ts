import type { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../protocol.ts";
import { openCheckedDatabase, validateBinding } from "../session-binding.ts";
import { expandSource } from "./expansion.ts";
import { initializeContextSchema } from "./schema.ts";
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
import { fingerprintOf, validId, validRef } from "./validation.ts";
import {
	decodeWorkingRow,
	mergeWorkingFields,
	type WorkingRow,
} from "./working-state.ts";

interface SummaryRow {
	id: string;
	text: string;
	kind: SummaryNode["kind"];
	depth: number;
	fingerprint: string;
}

interface SourceRow {
	source_kind: SourceRef["kind"];
	source_id: string;
}

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

	constructor(path: string, binding: BotBinding, lookupEntry: LookupEntry) {
		if (typeof lookupEntry !== "function")
			throw new Error("invalid entry lookup");
		const identity = validateBinding(binding);
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		this.lookupEntry = lookupEntry;
		let transaction = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			transaction = true;
			initializeContextSchema(this.db, identity, opened.fresh);
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
			text: input.text,
			kind: input.kind,
			sources,
		};
		const fingerprint = fingerprintOf(canonical);
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
				const parent = this.summaryRow(ref.id);
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
			sources.forEach((ref, ordinal) => {
				insert.run(id, ref.kind, ref.id, ordinal);
			});
			return {
				id,
				text: canonical.text,
				kind: canonical.kind,
				depth,
				sources,
				fingerprint,
			};
		});
	}

	get(id: string): SummaryNode | undefined {
		this.assertOpen();
		if (typeof id !== "string") return undefined;
		const row = this.summaryRow(id);
		if (!row) return undefined;
		return {
			id: row.id,
			text: row.text,
			kind: row.kind,
			depth: row.depth,
			sources: this.sourcesOf(id),
			fingerprint: row.fingerprint,
		};
	}

	active(): ActiveSummary | null {
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
			if (!this.summaryRow(id)) throw new Error(`unknown summary: ${id}`);
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
			const revision = (current?.revision ?? 0) + 1;
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

	working(): WorkingState {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT * FROM working_state WHERE id = 1")
			.get() as WorkingRow | undefined;
		if (!row) throw new Error("corrupt context working state");
		return decodeWorkingRow(row);
	}

	updateWorking(expectedRevision: number, fields: WorkingFields): WorkingState {
		this.assertOpen();
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("invalid working revision");
		return this.transaction(() => {
			const current = this.working();
			const next = mergeWorkingFields(current, fields, this.lookupEntry);
			if (current.revision !== expectedRevision)
				throw new Error("stale working revision");
			const revision = current.revision + 1;
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
			return { revision, ...next };
		});
	}

	expand(ref: SourceRef, options: ExpandOptions = {}): ExpandPage {
		this.assertOpen();
		return expandSource(ref, options, this.lookupEntry, (id) => this.get(id));
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("context store is closed");
	}

	private summaryRow(id: string): SummaryRow | undefined {
		return this.db
			.prepare(
				"SELECT id, text, kind, depth, fingerprint FROM summaries WHERE id = ?",
			)
			.get(id) as SummaryRow | undefined;
	}

	private sourcesOf(id: string): SourceRef[] {
		return (
			this.db
				.prepare(
					"SELECT source_kind, source_id FROM summary_sources WHERE summary_id = ? ORDER BY ordinal",
				)
				.all(id) as unknown as SourceRow[]
		).map((row) => ({ kind: row.source_kind, id: row.source_id }));
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
