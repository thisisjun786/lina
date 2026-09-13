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
import { type CandidateSet, parseCandidateSet } from "./judgment-candidates.ts";
import {
	buildDialogueJudgmentRef,
	type DialogueJudgmentRef,
	type DialogueResolutionRecord,
	parseDialogueJudgmentRef,
	parseStoredResolutionRecord,
	type StoredResolutionRecord,
	validateDialogueResolution,
} from "./judgment-dialogue.ts";
import { validateCandidateEvidence } from "./judgment-evidence.ts";
import {
	personalPolicyFor,
	personalPolicyIfDeclared,
	resolvePersonalRound,
} from "./judgment-policy.ts";
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

/** The only holdReason that ends a round as a terminal deferred receipt, whether
 * its evidence is incomplete or it replayed to a hold under revision 2. */
export const EVALUATION_BUDGET_EXHAUSTED = "evaluation budget exhausted";

function validateResolutionBinding(
	resolution: StoredResolutionRecord,
	selection: SelectionSpec | null,
	set: AssessmentSet | null,
	snapshot: JudgmentSnapshotRef,
	candidates: CandidateSet | null,
	lookupIntention: (id: string) => IntentionRecord | null,
	assessments: Assessment[],
	stored: boolean,
): void {
	if (resolution.schemaVersion === 2) {
		if (selection !== null || candidates !== null)
			throw Error("dialogue forbids action candidates and selection");
		validateDialogueResolution(resolution, snapshot, assessments);
		return;
	}
	// Without complete evidence only a non-executable receipt is trusted, and it
	// never carries a selection.
	if (!candidates || !set) {
		if (
			selection !== null ||
			(resolution.status !== "held" && resolution.status !== "deferred")
		)
			throw Error(!set ? "incomplete assessment set" : "missing candidate set");
		// A held round keeps its original latitude and declares no policy here;
		// resolving one would reject historical bytes on every ledger read.
		if (resolution.status === "held") return;
		// Revision 2 owns the terminal receipt and only an exhausted budget earns
		// it, so a round with remaining budget stays open for its missing work.
		const declared = personalPolicyIfDeclared(
			snapshot.policyId,
			snapshot.policyRevision,
		);
		// A later build may have written this receipt. Auditing persisted bytes
		// preserves it as history; a fresh write still needs a policy to check.
		if (!declared) {
			if (stored) return;
			throw Error("unsupported personal policy declaration");
		}
		if (declared.revision < 2)
			throw Error("incomplete deferred requires policy revision 2");
		if (resolution.holdReason !== EVALUATION_BUDGET_EXHAUSTED)
			throw Error("incomplete deferred requires exhausted evaluation budget");
		// It cannot be policy-replayed, so it may restate only the declared order
		// and what its stored assessments prove.
		const recommendations: Record<ModuleKind, string[]> = {
			clotho: [],
			lachesis: [],
			atropos: [],
		};
		for (const assessment of assessments)
			recommendations[assessment.moduleKind] = [
				...assessment.recommendedOptionKeys,
			];
		if (
			body(resolution.order) !==
				body([...declared.orders[snapshot.situation]]) ||
			body(resolution.recommendations) !== body(recommendations) ||
			resolution.excluded.length !== 0 ||
			resolution.abstentions.length !== 0 ||
			resolution.conflicts.length !== 0 ||
			resolution.ranking.length !== 0 ||
			resolution.conceded.length !== 0
		)
			throw Error("incomplete deferred asserts unsupported arbitration");
		return;
	}
	const policy = personalPolicyFor(snapshot.policyId, snapshot.policyRevision);
	const replayed = resolvePersonalRound({
		policy,
		snapshot,
		options: candidates.options,
		eligibility: candidates.eligibility,
		set,
		evidence: { candidates, lookupIntention },
		bias: Object.fromEntries(
			selection?.candidates.map((c) => [c.optionKey, c.b]) ?? [],
		),
	});
	// Budget exhaustion is a revision 2 rule: only a hold that policy replayed
	// under it becomes terminal, every other field still matches the replay, and
	// a resolved replay is never converted. Revision 1 holds stay retryable.
	const budgetExhausted =
		policy.revision >= 2 &&
		replayed.resolution.status === "held" &&
		resolution.status === "deferred" &&
		resolution.holdReason === EVALUATION_BUDGET_EXHAUSTED &&
		body({
			...resolution,
			status: "held",
			holdReason: replayed.resolution.holdReason,
		}) === body(replayed.resolution);
	if (body(resolution) !== body(replayed.resolution) && !budgetExhausted)
		throw Error("resolution policy replay mismatch");
	if (selection === null || replayed.spec === null) {
		if (selection !== replayed.spec)
			throw Error("selection policy replay mismatch");
		return;
	}
	if (selection.assessmentSetDigest !== judgmentDigest(set))
		throw Error("selection assessment set mismatch");
	if (selection.resolutionDigest !== judgmentDigest(resolution))
		throw Error("selection resolution digest mismatch");
	if (
		selection.policyId !== resolution.policyId ||
		selection.policyRevision !== resolution.policyRevision ||
		selection.situation !== resolution.situation
	)
		throw Error("selection policy mismatch");
	if (
		body(selection.objectiveProfileRefs) !== body(snapshot.objectiveProfileRefs)
	)
		throw Error("selection objective refs mismatch");
	if (body(selection) !== body(replayed.spec))
		throw Error("selection policy replay mismatch");
}

/** The Host owns the single writer; this ledger is independent of session lifetimes. */
export class JudgmentStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private closed = false;
	private validatedDataVersion: number | undefined;

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
		return this.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT body, digest FROM objective_profiles WHERE objective_id = ? AND revision = ?",
				)
				.get(
					boundedId(objectiveId, "objective id"),
					revision(profileRevision, 1),
				);
			if (!row) return null;
			const { body: json, digest } = row;
			const parsed = parseObjectiveProfile(JSON.parse(String(json)));
			if (judgmentDigest(parsed) !== digest)
				throw Error("objective profile digest mismatch");
			return parsed;
		}, false);
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
			const nextRefs = body({
				...this.activeObjectiveProfiles(agent, scope),
				[profile.moduleKind]: parsed,
			});
			// An open snapshot may become stale, but activation must not revive it.
			for (const row of this.db
				.prepare(
					"SELECT snapshot FROM rounds WHERE agent_id = ? AND scope_id = ? AND status = 'open'",
				)
				.all(agent, scope)) {
				const snapshot = parseJudgmentSnapshotRef(
					JSON.parse(String(row["snapshot"])),
				);
				if (body(snapshot.objectiveProfileRefs) === nextRefs)
					throw Error("objective reactivation would revive stale round");
			}
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
		return this.transaction(() => {
			const rows = this.db
				.prepare(`SELECT p.body, p.digest FROM objective_profile_active a JOIN objective_profiles p
				ON p.objective_id = a.objective_id AND p.revision = a.revision WHERE a.agent_id = ? AND a.scope_id = ?`)
				.all(boundedId(agentId, "agent id"), boundedId(scopeId, "scope id"));
			const refs: Partial<Record<ModuleKind, ObjectiveProfileRef>> = {};
			for (const { body: json, digest } of rows) {
				const profile = parseObjectiveProfile(JSON.parse(String(json)));
				if (judgmentDigest(profile) !== digest)
					throw Error("objective profile digest mismatch");
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
		}, false);
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
			if (
				parsed.intentionRevision !==
				this.intentionRevision(parsed.agentId, parsed.scopeId)
			)
				throw Error("stale intention revision");
			const highWater = this.db
				.prepare(
					"SELECT MAX(sequence) AS sequence FROM rounds WHERE agent_id = ? AND scope_id = ?",
				)
				.get(parsed.agentId, parsed.scopeId);
			if (
				highWater?.["sequence"] !== null &&
				parsed.sequence <= Number(highWater?.["sequence"])
			)
				throw Error("stale round sequence");
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
		return this.transaction(() => {
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
		}, false);
	}

	/** Freeze the exact Host universe and provenance once, while its round is open. */
	closeCandidateSet(set: CandidateSet): void {
		this.assertOpen();
		const parsed = parseCandidateSet(set);
		this.transaction(() => {
			const round = this.requireOpenRound(parsed.roundId);
			if (this.candidateSet(parsed.roundId))
				throw Error("candidate set already closed");
			validateCandidateEvidence(
				parsed,
				round.snapshot,
				(id) => this.getIntention(id),
				this.storedAssessments(parsed.roundId),
				true,
			);
			this.db
				.prepare(
					"INSERT INTO candidate_sets(round_id, snapshot_digest, candidate_digest, body, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					parsed.roundId,
					parsed.snapshotDigest,
					parsed.candidateDigest,
					body(parsed),
					this.now(),
				);
		});
	}

	candidateSet(roundId: string): CandidateSet | null {
		return this.transaction(() => {
			const row = this.db
				.prepare("SELECT body FROM candidate_sets WHERE round_id = ?")
				.get(boundedId(roundId, "round id"));
			if (!row) return null;
			const { body: json } = row;
			return parseCandidateSet(JSON.parse(String(json)));
		}, false);
	}

	private storedAssessments(roundId: string): Assessment[] {
		return this.db
			.prepare("SELECT body FROM assessments WHERE round_id = ?")
			.all(roundId)
			.map(({ body: json }) => parseAssessment(JSON.parse(String(json))));
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
			const candidates = this.candidateSet(parsed.snapshotId);
			if (candidates)
				validateCandidateEvidence(
					candidates,
					round.snapshot,
					(id) => this.getIntention(id),
					[parsed],
					false,
				);
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
		return this.transaction(() => {
			const round = this.getRound(roundId);
			const rows = this.db
				.prepare(
					"SELECT body, digest, input_digest, snapshot_digest FROM assessments WHERE round_id = ?",
				)
				.all(boundedId(roundId, "round id"));
			if (!round || rows.length !== MODULE_KINDS.length)
				throw Error("incomplete assessment set");
			const assessments = rows.map(
				({
					body: json,
					digest,
					input_digest: inputDigest,
					snapshot_digest: snapshot,
				}) => {
					const parsed = parseAssessment(JSON.parse(String(json)));
					if (judgmentDigest(parsed) !== digest)
						throw Error("assessment digest mismatch");
					if (parsed.inputDigest !== inputDigest)
						throw Error("assessment input digest mismatch");
					if (parsed.snapshotDigest !== snapshot)
						throw Error("assessment snapshot digest mismatch");
					return parsed;
				},
			);
			return parseAssessmentSet({
				schemaVersion: 1,
				roundId,
				snapshotDigest: round.snapshotDigest,
				assessments: MODULE_KINDS.map((module) =>
					assessments.find((item) => item.moduleKind === module),
				),
			});
		}, false);
	}

	recordResolution(
		roundId: string,
		resolution: StoredResolutionRecord,
		spec: SelectionSpec | null,
	): void {
		this.assertOpen();
		const id = boundedId(roundId, "round id");
		const parsed = parseStoredResolutionRecord(resolution);
		const selection = spec === null ? null : parseSelectionSpec(spec);
		this.transaction(() => {
			const round = this.requireOpenRound(id);
			if (
				body(
					this.activeObjectiveProfiles(
						round.snapshot.agentId,
						round.snapshot.scopeId,
					),
				) !== body(round.snapshot.objectiveProfileRefs)
			)
				throw Error("stale objective profile refs");
			if (
				round.snapshot.intentionRevision !==
				this.intentionRevision(round.snapshot.agentId, round.snapshot.scopeId)
			)
				throw Error("stale intention revision");
			if (parsed.roundId !== id) throw Error("resolution round mismatch");
			if (
				parsed.situation !== round.snapshot.situation ||
				parsed.policyId !== round.snapshot.policyId ||
				parsed.policyRevision !== round.snapshot.policyRevision
			)
				throw Error("resolution snapshot mismatch");
			const needsSelection =
				parsed.schemaVersion === 1 && parsed.status === "resolved";
			if (
				needsSelection !== (selection !== null) ||
				(selection &&
					(selection.roundId !== id ||
						selection.snapshotDigest !== round.snapshotDigest))
			)
				throw Error("selection spec mismatch");
			const candidates = this.candidateSet(id);
			const assessments = this.storedAssessments(id);
			if (candidates)
				validateCandidateEvidence(
					candidates,
					round.snapshot,
					(id) => this.getIntention(id),
					assessments,
					false,
				);
			const set =
				assessments.length === MODULE_KINDS.length
					? this.assessmentSet(id)
					: null;
			validateResolutionBinding(
				parsed,
				selection,
				set,
				round.snapshot,
				candidates,
				(id) => this.getIntention(id),
				assessments,
				false,
			);
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

	getResolution(roundId: string): StoredResolutionRecord | null;
	getResolution(roundId: string, mode: "action"): ResolutionRecord | null;
	getResolution(
		roundId: string,
		mode: "dialogue",
	): DialogueResolutionRecord | null;
	getResolution(
		roundId: string,
		mode?: "action" | "dialogue",
	): StoredResolutionRecord | null {
		return this.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT body, digest FROM resolution_records WHERE round_id = ?",
				)
				.get(boundedId(roundId, "round id"));
			if (!row) return null;
			const { body: json, digest } = row;
			const parsed = parseStoredResolutionRecord(JSON.parse(String(json)));
			if (judgmentDigest(parsed) !== digest)
				throw Error("resolution digest mismatch");
			if (mode !== undefined && mode !== "action" && mode !== "dialogue")
				throw Error("invalid resolution mode");
			if (
				mode !== undefined &&
				mode !== (parsed.schemaVersion === 1 ? "action" : "dialogue")
			)
				return null;
			return parsed;
		}, false);
	}

	/** Reconstructible immutable reference, not a response-acceptance receipt. */
	dialogueJudgmentRef(roundId: string): DialogueJudgmentRef | null {
		return this.transaction(() => {
			const resolution = this.getResolution(roundId, "dialogue");
			if (resolution?.status !== "resolved") return null;
			const round = this.getRound(roundId);
			if (!round) throw Error("dialogue round missing");
			return buildDialogueJudgmentRef({
				snapshot: round.snapshot,
				assessments: this.storedAssessments(roundId),
				resolution,
			});
		}, false);
	}

	validateDialogueJudgmentRef(value: DialogueJudgmentRef): void {
		const ref = parseDialogueJudgmentRef(value);
		this.transaction(() => {
			if (body(ref) !== body(this.dialogueJudgmentRef(ref.roundId)))
				throw Error("dialogue judgment ref mismatch");
		}, false);
	}

	getSelectionSpec(roundId: string): SelectionSpec | null {
		return this.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT body, spec_digest FROM selection_specs WHERE round_id = ?",
				)
				.get(boundedId(roundId, "round id"));
			if (!row) return null;
			const { body: json, spec_digest: digest } = row;
			const parsed = parseSelectionSpec(JSON.parse(String(json)));
			if (parsed.specDigest !== digest)
				throw Error("selection spec digest mismatch");
			return parsed;
		}, false);
	}

	/** Scoped create/+1-transition mutation counter; no delete or scope-move API.
	 * Keep this invariant if future mutation APIs are introduced. */
	intentionRevision(agentId: string, scopeId: string): number {
		return this.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT COALESCE(SUM(1 + revision), 0) AS revision FROM intention_records WHERE agent_id = ? AND scope_id = ?",
				)
				.get(boundedId(agentId, "agent id"), boundedId(scopeId, "scope id"));
			return revision(Number(row?.["revision"]));
		}, false);
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
			revision(this.intentionRevision(parsed.agentId, parsed.scopeId) + 1);
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
			revision(this.intentionRevision(record.agentId, record.scopeId) + 1);
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
		return this.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT body, digest FROM intention_records WHERE intention_id = ?",
				)
				.get(boundedId(intentionId, "intention id"));
			if (!row) return null;
			const { body: json, digest } = row;
			const parsed = parseIntentionRecord(JSON.parse(String(json)));
			if (intentionDigest(parsed) !== digest)
				throw Error("intention digest mismatch");
			return parsed;
		}, false);
	}

	listIntentions(
		agentId: string,
		scopeId: string,
		status?: IntentionStatus,
	): IntentionRecord[] {
		return this.transaction(() => {
			const agent = boundedId(agentId, "agent id");
			const scope = boundedId(scopeId, "scope id");
			if (status !== undefined && !INTENTION_STATUSES.includes(status))
				throw Error("invalid intention status");
			const statement = this.db.prepare(
				status === undefined
					? "SELECT body, digest FROM intention_records WHERE agent_id = ? AND scope_id = ? ORDER BY intention_id"
					: "SELECT body, digest FROM intention_records WHERE agent_id = ? AND scope_id = ? AND status = ? ORDER BY intention_id",
			);
			const rows =
				status === undefined
					? statement.all(agent, scope)
					: statement.all(agent, scope, status);
			return rows.map(({ body: json, digest }) => {
				const parsed = parseIntentionRecord(JSON.parse(String(json)));
				if (intentionDigest(parsed) !== digest)
					throw Error("intention digest mismatch");
				return parsed;
			});
		}, false);
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

	/** Scan before any indexed filter, on the same SQLite snapshot as the call.
	 * Own writes preserve these invariants; only an external commit (or reopen)
	 * requires another scan. Never recurse through public getters here.
	 */
	private validateLedger(): void {
		const rows = <T>(
			table: string,
			label: string,
			parse: (value: unknown) => T,
			metadata: (value: T) => Record<string, unknown>,
			digest: (value: T) => string = judgmentDigest,
			jsonColumn = "body",
			digestColumn = "digest",
		) =>
			this.db
				.prepare(`SELECT * FROM ${table}`)
				.all()
				.map((row) => {
					const value = parse(JSON.parse(String(row[jsonColumn])));
					if (digest(value) !== row[digestColumn])
						throw Error(`${label} digest mismatch`);
					for (const [column, expected] of Object.entries(metadata(value))) {
						if (row[column] !== expected) {
							if (table === "assessments" && column === "input_digest")
								throw Error("assessment input digest mismatch");
							if (table === "assessments" && column === "snapshot_digest")
								throw Error("assessment snapshot digest mismatch");
							throw Error(`${label} metadata mismatch`);
						}
					}
					return { row, value };
				});
		const profiles = rows(
			"objective_profiles",
			"objective profile",
			parseObjectiveProfile,
			(p) => ({
				objective_id: p.objectiveId,
				revision: p.revision,
				module_kind: p.moduleKind,
			}),
		);
		const profilesByRef = new Map(
			profiles.map((entry) => [
				body([entry.value.objectiveId, entry.value.revision]),
				entry,
			]),
		);
		for (const row of this.db
			.prepare("SELECT * FROM objective_profile_active")
			.all()) {
			const {
				objective_id,
				revision: profileRevision,
				module_kind,
				agent_id,
				scope_id,
				activation_revision,
			} = row;
			if (
				profilesByRef.get(body([objective_id, profileRevision]))?.value
					.moduleKind !== module_kind
			)
				throw Error("objective activation metadata mismatch");
			boundedId(agent_id, "agent id");
			boundedId(scope_id, "scope id");
			revision(Number(activation_revision), 1);
		}
		const rounds = rows(
			"rounds",
			"snapshot",
			parseJudgmentSnapshotRef,
			(p) => ({
				round_id: p.roundId,
				agent_id: p.agentId,
				scope_id: p.scopeId,
				situation: p.situation,
				sequence: p.sequence,
			}),
			snapshotDigest,
			"snapshot",
			"snapshot_digest",
		);
		const candidates = rows(
			"candidate_sets",
			"candidate set",
			parseCandidateSet,
			(p) => ({ round_id: p.roundId, snapshot_digest: p.snapshotDigest }),
			(p) => p.candidateDigest,
			"body",
			"candidate_digest",
		);
		const assessments = rows(
			"assessments",
			"assessment",
			parseAssessment,
			(p) => ({
				round_id: p.snapshotId,
				module_kind: p.moduleKind,
				input_digest: p.inputDigest,
				snapshot_digest: p.snapshotDigest,
			}),
		);
		const resolutions = rows(
			"resolution_records",
			"resolution",
			parseStoredResolutionRecord,
			(p) => ({ round_id: p.roundId }),
		);
		const statuses = new Map(
			resolutions.map(({ value: p }) => [p.roundId, p.status]),
		);
		for (const {
			row: { status },
			value,
		} of rounds) {
			if (status !== (statuses.get(value.roundId) ?? "open"))
				throw Error("round status metadata mismatch");
			for (const module of MODULE_KINDS) {
				const ref = value.objectiveProfileRefs[module];
				const profile = profilesByRef.get(
					body([ref.objectiveId, ref.revision]),
				);
				if (
					!profile ||
					profile.value.moduleKind !== module ||
					profile.row["digest"] !== ref.digest
				)
					throw Error("snapshot objective profile mismatch");
			}
		}
		const selections = rows(
			"selection_specs",
			"selection spec",
			parseSelectionSpec,
			(p) => ({ round_id: p.roundId }),
			(p) => p.specDigest,
			"body",
			"spec_digest",
		);
		const selectedRounds = new Set(
			selections.map(({ value }) => value.roundId),
		);
		for (const { value } of resolutions) {
			if (
				(value.schemaVersion === 1 && value.status === "resolved") !==
				selectedRounds.has(value.roundId)
			)
				throw Error("selection spec metadata mismatch");
		}
		const snapshots = new Map(
			rounds.map(({ value }) => [value.roundId, value]),
		);
		const records = new Map(
			resolutions.map(({ value }) => [value.roundId, value]),
		);
		for (const { value } of resolutions) {
			const snapshot = snapshots.get(value.roundId);
			if (
				!snapshot ||
				value.policyId !== snapshot.policyId ||
				value.policyRevision !== snapshot.policyRevision ||
				value.situation !== snapshot.situation
			)
				throw Error("resolution snapshot mismatch");
		}
		const sets = new Map<string, Assessment[]>();
		for (const { value } of assessments) {
			const snapshot = snapshots.get(value.snapshotId);
			if (!snapshot) throw Error("judgment foreign key mismatch");
			if (value.snapshotDigest !== snapshotDigest(snapshot))
				throw Error("assessment snapshot mismatch");
			if (
				body(value.objectiveRef) !==
				body(snapshot.objectiveProfileRefs[value.moduleKind])
			)
				throw Error("assessment objective mismatch");
			const set = sets.get(value.snapshotId) ?? [];
			set.push(value);
			sets.set(value.snapshotId, set);
		}
		for (const { value: selection } of selections) {
			const snapshot = snapshots.get(selection.roundId);
			const record = records.get(selection.roundId);
			if (
				!snapshot ||
				!record ||
				record.status !== "resolved" ||
				selection.snapshotDigest !== snapshotDigest(snapshot)
			)
				throw Error("selection spec metadata mismatch");
		}
		const intentions = rows(
			"intention_records",
			"intention",
			parseIntentionRecord,
			(p) => ({
				intention_id: p.intentionId,
				agent_id: p.agentId,
				scope_id: p.scopeId,
				revision: p.revision,
				status: p.status,
			}),
			intentionDigest,
		);
		const histories = new Map(
			intentions.map(({ value: p }) => [p.intentionId, p.history]),
		);
		const transitions = this.db
			.prepare("SELECT * FROM intention_transitions")
			.all();
		if (
			transitions.length !==
			intentions.reduce((n, { value }) => n + value.history.length, 0)
		)
			throw Error("intention transition metadata mismatch");
		for (const row of transitions) {
			const {
				intention_id,
				revision: transitionRevision,
				from_status,
				to_status,
				reason,
				evidence_ref,
				at,
			} = row;
			const history = histories.get(String(intention_id));
			const entry = history?.[Number(transitionRevision) - 1];
			if (
				!entry ||
				entry.from !== from_status ||
				entry.to !== to_status ||
				entry.reason !== reason ||
				entry.evidenceRef !== evidence_ref ||
				entry.at !== at
			)
				throw Error("intention transition metadata mismatch");
		}
		const intentionsById = new Map(
			intentions.map(({ value }) => [value.intentionId, value]),
		);
		const candidatesByRound = new Map(
			candidates.map(({ value }) => [value.roundId, value]),
		);
		for (const { value } of candidates) {
			const snapshot = snapshots.get(value.roundId);
			if (!snapshot) throw Error("judgment foreign key mismatch");
			validateCandidateEvidence(
				value,
				snapshot,
				(id) => intentionsById.get(id) ?? null,
				sets.get(value.roundId) ?? [],
				false,
			);
		}
		const selectionsByRound = new Map(
			selections.map(({ value }) => [value.roundId, value]),
		);
		for (const { value: record } of resolutions) {
			const snapshot = snapshots.get(record.roundId);
			if (!snapshot) throw Error("resolution snapshot mismatch");
			const assessments = sets.get(record.roundId) ?? [];
			let set: AssessmentSet | null = null;
			if (assessments.length === MODULE_KINDS.length) {
				set = parseAssessmentSet({
					schemaVersion: 1,
					roundId: record.roundId,
					snapshotDigest: snapshotDigest(snapshot),
					assessments: MODULE_KINDS.map((module) =>
						assessments.find((a) => a.moduleKind === module),
					),
				});
			}
			validateResolutionBinding(
				record,
				selectionsByRound.get(record.roundId) ?? null,
				set,
				snapshot,
				candidatesByRound.get(record.roundId) ?? null,
				(id) => intentionsById.get(id) ?? null,
				assessments,
				true,
			);
		}
		if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0)
			throw Error("judgment foreign key mismatch");
	}

	private transaction<T>(fn: () => T, write = true): T {
		this.assertOpen();
		if (this.db.isTransaction) return fn();
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			// Establish the read snapshot before observing data_version. Otherwise an
			// external commit could be scanned under one version and cached as another.
			this.db
				.prepare("SELECT value FROM judgment_meta WHERE key = 'store'")
				.get();
			const { data_version: dataVersion } =
				this.db.prepare("PRAGMA data_version").get() ?? {};
			if (dataVersion !== this.validatedDataVersion) {
				this.validateLedger();
				this.validatedDataVersion = Number(dataVersion);
			}
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
