import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../session-binding.ts";
import {
	type Assessment,
	type AssessmentSet,
	INTENTION_STATUSES,
	type IntentionRecord,
	type IntentionStatus,
	type IntentionTransition,
	type JudgmentSnapshotRef,
	MODULE_KINDS,
	type ModuleKind,
	type ObjectiveProfile,
	type ObjectiveProfileRef,
	type ResolutionRecord,
	type RoundStatus,
	type SelectionSpec,
} from "./judgment.ts";
import { initializeJudgmentSchema } from "./judgment-schema.ts";
import {
	canonicalJson,
	intentionDigest,
	judgmentDigest,
	parseAssessment,
	parseAssessmentSet,
	parseIntentionRecord,
	parseIntentionTransition,
	parseJudgmentSnapshotRef,
	parseObjectiveProfile,
	parseObjectiveProfileRef,
	parseResolutionRecord,
	parseSelectionSpec,
	snapshotDigest,
	transitionIntention,
} from "./judgment-validation.ts";
import { boundedId } from "./validation.ts";

function body(value: unknown): string {
	return canonicalJson(value);
}
function revision(value: number, minimum = 0): number {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw Error("invalid judgment revision");
	return value;
}

/** The Host owns the single writer; this ledger is independent of session lifetimes. */
export class JudgmentStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private closed = false;

	constructor(path: string, options: { now?: () => number } = {}) {
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		this.now = options.now ?? Date.now;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			initializeJudgmentSchema(this.db, opened.fresh);
			this.db.exec(
				"COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
			);
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	putObjectiveProfile(profile: ObjectiveProfile): ObjectiveProfileRef {
		this.assertOpen();
		const parsed = parseObjectiveProfile(profile);
		const ref = {
			objectiveId: parsed.objectiveId,
			revision: parsed.revision,
			digest: judgmentDigest(parsed),
		};
		return this.transaction(() => {
			const existing = this.getObjectiveProfile(ref.objectiveId, ref.revision);
			if (existing) {
				if (judgmentDigest(existing) !== ref.digest)
					throw Error("objective profile revision already exists");
				return ref;
			}
			this.db
				.prepare(
					"INSERT INTO objective_profiles(objective_id, revision, module_kind, digest, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					ref.objectiveId,
					ref.revision,
					parsed.moduleKind,
					ref.digest,
					body(parsed),
					this.now(),
				);
			return ref;
		});
	}

	getObjectiveProfile(
		objectiveId: string,
		profileRevision: number,
	): ObjectiveProfile | null {
		this.assertOpen();
		const row = this.db
			.prepare(
				"SELECT body FROM objective_profiles WHERE objective_id = ? AND revision = ?",
			)
			.get(
				boundedId(objectiveId, "objective id"),
				revision(profileRevision, 1),
			);
		const { body: json } = row ?? {};
		return row ? parseObjectiveProfile(JSON.parse(String(json))) : null;
	}

	activateObjectiveProfile(
		agentId: string,
		scopeId: string,
		ref: ObjectiveProfileRef,
	): { activationRevision: number } {
		this.assertOpen();
		const agent = boundedId(agentId, "agent id");
		const scope = boundedId(scopeId, "scope id");
		const parsed = parseObjectiveProfileRef(ref);
		return this.transaction(() => {
			const profile = this.getObjectiveProfile(
				parsed.objectiveId,
				parsed.revision,
			);
			if (!profile || judgmentDigest(profile) !== parsed.digest)
				throw Error("objective profile ref mismatch");
			const existing = this.db
				.prepare(
					"SELECT objective_id, revision, activation_revision FROM objective_profile_active WHERE agent_id = ? AND scope_id = ? AND module_kind = ?",
				)
				.get(agent, scope, profile.moduleKind);
			const {
				objective_id: objectiveId,
				revision: activeRevision,
				activation_revision: previous,
			} = existing ?? {};
			if (
				objectiveId === parsed.objectiveId &&
				activeRevision === parsed.revision
			)
				return { activationRevision: Number(previous) };
			const activationRevision = revision(Number(previous ?? 0) + 1, 1);
			this.db
				.prepare(`INSERT INTO objective_profile_active(agent_id, scope_id, module_kind, objective_id, revision, activation_revision, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, scope_id, module_kind) DO UPDATE SET
				objective_id = excluded.objective_id, revision = excluded.revision, activation_revision = excluded.activation_revision, updated_at = excluded.updated_at`)
				.run(
					agent,
					scope,
					profile.moduleKind,
					parsed.objectiveId,
					parsed.revision,
					activationRevision,
					this.now(),
				);
			return { activationRevision };
		});
	}

	activeObjectiveProfiles(
		agentId: string,
		scopeId: string,
	): Record<ModuleKind, ObjectiveProfileRef> | null {
		this.assertOpen();
		const rows = this.db
			.prepare(`SELECT p.body FROM objective_profile_active a JOIN objective_profiles p
			ON p.objective_id = a.objective_id AND p.revision = a.revision WHERE a.agent_id = ? AND a.scope_id = ?`)
			.all(boundedId(agentId, "agent id"), boundedId(scopeId, "scope id"));
		const refs: Partial<Record<ModuleKind, ObjectiveProfileRef>> = {};
		for (const { body: json } of rows) {
			const profile = parseObjectiveProfile(JSON.parse(String(json)));
			refs[profile.moduleKind] = parseObjectiveProfileRef({
				objectiveId: profile.objectiveId,
				revision: profile.revision,
				digest: judgmentDigest(profile),
			});
		}
		if (!refs.clotho || !refs.lachesis || !refs.atropos) return null;
		return {
			clotho: refs.clotho,
			lachesis: refs.lachesis,
			atropos: refs.atropos,
		};
	}

	openRound(snapshot: JudgmentSnapshotRef): {
		roundId: string;
		snapshotDigest: string;
	} {
		this.assertOpen();
		const parsed = parseJudgmentSnapshotRef(snapshot);
		return this.transaction(() => {
			const active = this.activeObjectiveProfiles(
				parsed.agentId,
				parsed.scopeId,
			);
			if (body(active) !== body(parsed.objectiveProfileRefs))
				throw Error("stale objective profile refs");
			const digest = snapshotDigest(parsed);
			const now = this.now();
			this.db
				.prepare(`INSERT INTO rounds(round_id, agent_id, scope_id, situation, sequence, snapshot, snapshot_digest, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
				.run(
					parsed.roundId,
					parsed.agentId,
					parsed.scopeId,
					parsed.situation,
					parsed.sequence,
					body(parsed),
					digest,
					now,
					now,
				);
			return { roundId: parsed.roundId, snapshotDigest: digest };
		});
	}

	getRound(roundId: string): {
		snapshot: JudgmentSnapshotRef;
		status: RoundStatus;
		snapshotDigest: string;
	} | null {
		this.assertOpen();
		const row = this.db
			.prepare(
				"SELECT snapshot, status, snapshot_digest FROM rounds WHERE round_id = ?",
			)
			.get(boundedId(roundId, "round id"));
		if (!row) return null;
		const { snapshot, status, snapshot_digest: digest } = row;
		const parsed = parseJudgmentSnapshotRef(JSON.parse(String(snapshot)));
		if (snapshotDigest(parsed) !== digest)
			throw Error("snapshot digest mismatch");
		return {
			snapshot: parsed,
			status: status as RoundStatus,
			snapshotDigest: String(digest),
		};
	}

	putAssessment(assessment: Assessment): void {
		this.assertOpen();
		const parsed = parseAssessment(assessment);
		this.transaction(() => {
			const round = this.requireOpenRound(parsed.snapshotId);
			if (
				parsed.snapshotId !== round.snapshot.roundId ||
				parsed.snapshotDigest !== round.snapshotDigest
			)
				throw Error("assessment snapshot mismatch");
			const objective = round.snapshot.objectiveProfileRefs[parsed.moduleKind];
			if (
				parsed.objectiveRef.objectiveId !== objective.objectiveId ||
				parsed.objectiveRef.revision !== objective.revision ||
				parsed.objectiveRef.digest !== objective.digest
			)
				throw Error("assessment objective mismatch");
			if (
				this.db
					.prepare(
						"SELECT 1 FROM assessments WHERE round_id = ? AND module_kind = ?",
					)
					.get(parsed.snapshotId, parsed.moduleKind)
			)
				throw Error("duplicate assessment");
			this.db
				.prepare(
					"INSERT INTO assessments(round_id, module_kind, snapshot_digest, input_digest, digest, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					parsed.snapshotId,
					parsed.moduleKind,
					parsed.snapshotDigest,
					parsed.inputDigest,
					judgmentDigest(parsed),
					body(parsed),
					this.now(),
				);
		});
	}

	assessmentSet(roundId: string): AssessmentSet {
		this.assertOpen();
		const round = this.getRound(roundId);
		const rows = this.db
			.prepare("SELECT body FROM assessments WHERE round_id = ?")
			.all(boundedId(roundId, "round id"));
		if (!round || rows.length !== MODULE_KINDS.length)
			throw Error("incomplete assessment set");
		const assessments = rows.map(({ body: json }) =>
			parseAssessment(JSON.parse(String(json))),
		);
		return parseAssessmentSet({
			schemaVersion: 1,
			roundId,
			snapshotDigest: round.snapshotDigest,
			assessments: MODULE_KINDS.map((module) =>
				assessments.find((item) => item.moduleKind === module),
			),
		});
	}

	recordResolution(
		roundId: string,
		resolution: ResolutionRecord,
		spec: SelectionSpec | null,
	): void {
		this.assertOpen();
		const id = boundedId(roundId, "round id");
		const parsed = parseResolutionRecord(resolution);
		const selection = spec === null ? null : parseSelectionSpec(spec);
		this.transaction(() => {
			const round = this.requireOpenRound(id);
			if (parsed.roundId !== id) throw Error("resolution round mismatch");
			if (
				parsed.situation !== round.snapshot.situation ||
				parsed.policyId !== round.snapshot.policyId ||
				parsed.policyRevision !== round.snapshot.policyRevision
			)
				throw Error("resolution snapshot mismatch");
			if (
				(parsed.status === "resolved") !== (selection !== null) ||
				(selection &&
					(selection.roundId !== id ||
						selection.snapshotDigest !== round.snapshotDigest))
			)
				throw Error("selection spec mismatch");
			if (selection) {
				const set = this.assessmentSet(id);
				if (selection.assessmentSetDigest !== judgmentDigest(set))
					throw Error("selection assessment set mismatch");
				if (selection.resolutionDigest !== judgmentDigest(parsed))
					throw Error("selection resolution digest mismatch");
				if (
					selection.policyId !== parsed.policyId ||
					selection.policyRevision !== parsed.policyRevision ||
					selection.situation !== parsed.situation
				)
					throw Error("selection policy mismatch");
				if (
					canonicalJson(selection.objectiveProfileRefs) !==
					canonicalJson(round.snapshot.objectiveProfileRefs)
				)
					throw Error("selection objective refs mismatch");
			}
			const now = this.now();
			this.db
				.prepare(
					"INSERT INTO resolution_records(round_id, digest, body, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(id, judgmentDigest(parsed), body(parsed), now);
			if (selection)
				this.db
					.prepare(
						"INSERT INTO selection_specs(round_id, spec_digest, body, created_at) VALUES (?, ?, ?, ?)",
					)
					.run(id, selection.specDigest, body(selection), now);
			this.db
				.prepare(
					"UPDATE rounds SET status = ?, updated_at = ? WHERE round_id = ?",
				)
				.run(parsed.status, now, id);
		});
	}

	getResolution(roundId: string): ResolutionRecord | null {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT body FROM resolution_records WHERE round_id = ?")
			.get(boundedId(roundId, "round id"));
		const { body: json } = row ?? {};
		return row ? parseResolutionRecord(JSON.parse(String(json))) : null;
	}

	getSelectionSpec(roundId: string): SelectionSpec | null {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT body FROM selection_specs WHERE round_id = ?")
			.get(boundedId(roundId, "round id"));
		const { body: json } = row ?? {};
		return row ? parseSelectionSpec(JSON.parse(String(json))) : null;
	}

	putIntention(record: IntentionRecord): void {
		this.assertOpen();
		const parsed = parseIntentionRecord(record);
		if (
			parsed.status !== "proposed" ||
			parsed.revision !== 0 ||
			parsed.history.length !== 0
		)
			throw Error("intention must be proposed");
		this.transaction(() => {
			if (this.getIntention(parsed.intentionId))
				throw Error("duplicate intention");
			const now = this.now();
			this.db
				.prepare(
					"INSERT INTO intention_records(intention_id, agent_id, scope_id, revision, status, digest, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					parsed.intentionId,
					parsed.agentId,
					parsed.scopeId,
					parsed.revision,
					parsed.status,
					intentionDigest(parsed),
					body(parsed),
					now,
					now,
				);
		});
	}

	transitionIntention(
		intentionId: string,
		transition: Omit<IntentionTransition, "from">,
		expectedRevision: number,
	): IntentionRecord {
		this.assertOpen();
		const id = boundedId(intentionId, "intention id");
		revision(expectedRevision);
		return this.transaction(() => {
			const record = this.getIntention(id);
			if (!record) throw Error("unknown intention");
			if (record.revision !== expectedRevision)
				throw Error("stale intention revision");
			if (Object.hasOwn(transition, "from"))
				throw Error("unknown intention transition field from");
			const entry = parseIntentionTransition({
				from: record.status,
				...transition,
			});
			const updated = parseIntentionRecord(
				transitionIntention(record, transition),
			);
			this.db
				.prepare(
					"UPDATE intention_records SET revision = ?, status = ?, digest = ?, body = ?, updated_at = ? WHERE intention_id = ?",
				)
				.run(
					updated.revision,
					updated.status,
					intentionDigest(updated),
					body(updated),
					this.now(),
					id,
				);
			this.db
				.prepare(
					"INSERT INTO intention_transitions(intention_id, revision, from_status, to_status, reason, evidence_ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					updated.revision,
					entry.from,
					entry.to,
					entry.reason,
					entry.evidenceRef,
					entry.at,
				);
			return updated;
		});
	}

	getIntention(intentionId: string): IntentionRecord | null {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT body FROM intention_records WHERE intention_id = ?")
			.get(boundedId(intentionId, "intention id"));
		const { body: json } = row ?? {};
		return row ? parseIntentionRecord(JSON.parse(String(json))) : null;
	}

	listIntentions(
		agentId: string,
		scopeId: string,
		status?: IntentionStatus,
	): IntentionRecord[] {
		this.assertOpen();
		const agent = boundedId(agentId, "agent id");
		const scope = boundedId(scopeId, "scope id");
		if (status !== undefined && !INTENTION_STATUSES.includes(status))
			throw Error("invalid intention status");
		const rows =
			status === undefined
				? this.db
						.prepare(
							"SELECT body FROM intention_records WHERE agent_id = ? AND scope_id = ? ORDER BY intention_id",
						)
						.all(agent, scope)
				: this.db
						.prepare(
							"SELECT body FROM intention_records WHERE agent_id = ? AND scope_id = ? AND status = ? ORDER BY intention_id",
						)
						.all(agent, scope, status);
		return rows.map(({ body: json }) =>
			parseIntentionRecord(JSON.parse(String(json))),
		);
	}

	close(): void {
		this.assertOpen();
		this.db.close();
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw Error("judgment store is closed");
	}

	private requireOpenRound(roundId: string) {
		this.assertOpen();
		const round = this.getRound(roundId);
		if (!round) throw Error("unknown judgment round");
		if (round.status !== "open") throw Error("judgment round is not open");
		return round;
	}

	private transaction<T>(fn: () => T): T {
		this.assertOpen();
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
