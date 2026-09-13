import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Assessment,
	assessmentInputDigest,
	buildCandidateSet,
	buildCanonicalOption,
	type CanonicalOption,
	type IntentionRecord,
	intentionDigest,
	type JudgmentSnapshotRef,
	JudgmentStore,
	judgmentDigest,
	type ModuleKind,
	type ObjectiveProfile,
	PERSONAL_CATALOG_ID,
	PERSONAL_POLICY_V1,
	type PersonalOptionKind,
	parseAssessment,
	parseCanonicalOption,
	parseIntentionRecord,
	parseJudgmentSnapshotRef,
	parseObjectiveProfile,
	resolvePersonalRound,
	type SelectionSpec,
	type Situation,
	sampleSelection,
	snapshotDigest,
	transitionIntention,
} from "../src/agents/index.ts";
import { buildContextReadProjection } from "../src/context/index.ts";

const AGENT = "agent-1";
const SCOPE = "scope-1";
const PROJECTED_AT = "2026-09-12T00:00:00.000Z";
const actor = { agentId: AGENT, scopeId: SCOPE };

let dir: string | undefined;
let sqlitePath = "";
const stores = new Set<JudgmentStore>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-core-judgment-round-"));
	sqlitePath = join(dir, "judgment.sqlite");
});

afterEach(() => {
	for (const store of stores) store.close();
	stores.clear();
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function open(path = sqlitePath): JudgmentStore {
	const store = new JudgmentStore(path, { now: () => 1234 });
	stores.add(store);
	return store;
}

function close(store: JudgmentStore): void {
	store.close();
	stores.delete(store);
}

function contextProjection() {
	const working = {
		revision: 7,
		goal: "Keep working revision at seven",
		decisions: [],
		openItems: [],
		nextSteps: [],
		sourceEntryIds: [],
	};
	const previous = buildContextReadProjection({
		working,
		instruction: {
			requestId: "request-1",
			entryId: "entry-1",
			text: "first instruction",
		},
		previous: null,
		projectedAt: PROJECTED_AT,
	});
	return buildContextReadProjection({
		working,
		instruction: {
			requestId: "request-2",
			entryId: "entry-2",
			text: "second instruction",
		},
		previous,
		projectedAt: PROJECTED_AT,
	});
}

function profile(moduleKind: ModuleKind): ObjectiveProfile {
	return parseObjectiveProfile({
		schemaVersion: 1,
		objectiveId: `objective-${moduleKind}`,
		moduleKind,
		revision: 1,
		objective: `Fixture ${moduleKind} objective`,
		comparisonCriteria: [`${moduleKind} cost`, `${moduleKind} outcome`],
		reconsiderationConditions: [`${moduleKind} new evidence`],
	});
}

function putActivatedProfiles(store: JudgmentStore) {
	const clotho = profile("clotho");
	const lachesis = profile("lachesis");
	const atropos = profile("atropos");
	const clothoRef = store.putObjectiveProfile(clotho);
	const lachesisRef = store.putObjectiveProfile(lachesis);
	const atroposRef = store.putObjectiveProfile(atropos);
	expect(store.activateObjectiveProfile(AGENT, SCOPE, clothoRef)).toEqual({
		activationRevision: 1,
	});
	expect(store.activateObjectiveProfile(AGENT, SCOPE, lachesisRef)).toEqual({
		activationRevision: 1,
	});
	expect(store.activateObjectiveProfile(AGENT, SCOPE, atroposRef)).toEqual({
		activationRevision: 1,
	});
	return {
		clotho,
		lachesis,
		atropos,
		refs: { clotho: clothoRef, lachesis: lachesisRef, atropos: atroposRef },
	};
}

function canonicalOptions() {
	const adopt = buildCanonicalOption({
		kind: "intention.adopt",
		actor,
		targetId: "intention-1",
		args: {},
		preconditions: {
			kind: "intention.adopt",
			intentionKind: "autonomous_goal",
			sourceRef: "source-1",
		},
	});
	const start = buildCanonicalOption({
		kind: "task.start",
		actor,
		targetId: "task-1",
		args: {},
		preconditions: {
			kind: "task.start",
			authorityRef: "authority-1",
			taskText: "Start fixture task",
			intentionId: "intention-start",
		},
	});
	const inquire = buildCanonicalOption({
		kind: "inquire",
		actor,
		targetId: "ask-1",
		args: { topic: "what next" },
		preconditions: { kind: "inquire", authorityRef: "authority-1" },
	});
	const inquireVariant = buildCanonicalOption({
		kind: "Inquire" as PersonalOptionKind,
		actor,
		targetId: " ask-1 ",
		args: { topic: "  what   next  " },
		preconditions: { kind: "inquire", authorityRef: "authority-1" },
	});
	const noop = buildCanonicalOption({
		kind: "noop",
		actor,
		targetId: null,
		args: {},
		preconditions: { kind: "noop", reason: "nothing needed" },
	});
	return { adopt, start, inquire, inquireVariant, noop };
}

function snapshotRef(
	situation: Situation,
	refs: ReturnType<typeof putActivatedProfiles>["refs"],
	projection: ReturnType<typeof contextProjection>,
): JudgmentSnapshotRef {
	return parseJudgmentSnapshotRef({
		schemaVersion: 1,
		roundId: `round-${situation}`,
		agentId: AGENT,
		scopeId: SCOPE,
		sourceRefs: [],
		workingRevision: projection.workingRevision,
		instructionRevision: projection.instructionRevision,
		policyId: PERSONAL_POLICY_V1.policyId,
		policyRevision: 1,
		identityRevision: 1,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation,
		clockId: "clock-1",
		sequence: 1,
		bindingGeneration: 0,
	});
}

function stanceFor(
	moduleKind: ModuleKind,
	option: CanonicalOption,
): { stance: "prefer" | "accept" | "oppose"; severity: string | null } {
	if (moduleKind === "lachesis" && option.kind === "intention.adopt")
		return { stance: "prefer", severity: null };
	if (moduleKind === "clotho" && option.kind === "task.start")
		return { stance: "oppose", severity: "infeasible" };
	if (moduleKind === "atropos" && option.kind === "noop")
		return { stance: "oppose", severity: "commitment_breach" };
	return { stance: "accept", severity: null };
}

function assessmentFor(
	snapshot: JudgmentSnapshotRef,
	moduleKind: ModuleKind,
	options: CanonicalOption[],
): Assessment {
	const digest = snapshotDigest(snapshot);
	const objectiveRef = snapshot.objectiveProfileRefs[moduleKind];
	const objectiveAssessments = options.map((option) => {
		const { stance, severity } = stanceFor(moduleKind, option);
		return {
			optionKey: option.optionKey,
			stance,
			severity,
			unavailableReason: null,
			gain: "fixture gain",
			loss: "fixture loss",
			uncertainty: "fixture uncertainty",
			evidenceRefs: [],
			...(moduleKind === "atropos" && option.kind === "noop"
				? { breachedIntentionIds: ["protected-promise"] }
				: {}),
		};
	});
	return parseAssessment({
		schemaVersion: 1,
		moduleKind,
		snapshotId: snapshot.roundId,
		snapshotDigest: digest,
		inputDigest: assessmentInputDigest({
			snapshotDigest: digest,
			objectiveRef,
			mechanismRevision: 1,
		}),
		objectiveRef,
		mechanismRevision: 1,
		completeText: `Fixture ${moduleKind} assessment`,
		evidenceRefs: [],
		proposedOptionKeys: options.map((option) => option.optionKey),
		objectiveAssessments,
		recommendedOptionKeys: objectiveAssessments
			.filter((row) => row.stance === "prefer")
			.map((row) => row.optionKey),
		detail: {
			kind: {
				clotho: "forecasts",
				lachesis: "values",
				atropos: "continuity",
			}[moduleKind],
			body: {},
		},
		diagnostics: {},
	});
}

function proposedIntention(): IntentionRecord {
	return parseIntentionRecord({
		schemaVersion: 1,
		intentionId: "intention-1",
		agentId: AGENT,
		scopeId: SCOPE,
		revision: 0,
		kind: "autonomous_goal",
		purposeRef: "purpose-1",
		text: "Adopt the fixture intention",
		acceptance: {
			sourceRef: "source-1",
			acceptedBy: "host_autonomy",
			policyRevision: 1,
			acceptedAt: PROJECTED_AT,
		},
		priority: 0,
		deadline: null,
		completionCondition: "Fixture completion",
		abortConditions: [],
		relatedIntentions: [],
		status: "proposed",
		history: [],
	});
}

function p0(spec: SelectionSpec, optionKey: string): number | undefined {
	return spec.candidates.find((row) => row.optionKey === optionKey)?.p0;
}

function sortedAssessments(rows: Assessment[]): Assessment[] {
	return [...rows].sort((a, b) =>
		a.moduleKind < b.moduleKind ? -1 : a.moduleKind > b.moduleKind ? 1 : 0,
	);
}

const AUTONOMOUS_ORDER = ["lachesis", "clotho", "atropos"] as const;

function playRound(store: JudgmentStore, situation: Situation) {
	const projection = contextProjection();
	const profiles = putActivatedProfiles(store);
	const options = canonicalOptions();
	const candidates = [
		options.adopt,
		options.start,
		options.inquire,
		options.noop,
	];
	store.putIntention({
		...proposedIntention(),
		intentionId: "intention-start",
	});
	const startIntention = store.transitionIntention(
		"intention-start",
		{
			to: "adopted",
			reason: "existing task intention",
			evidenceRef: "source-1",
			at: PROJECTED_AT,
		},
		0,
	);
	const promise = proposedIntention();
	store.putIntention({
		...promise,
		intentionId: "protected-promise",
		kind: "user_commitment",
		acceptance: { ...promise.acceptance, acceptedBy: "user" },
	});
	const protectedIntention = store.transitionIntention(
		"protected-promise",
		{
			to: "adopted",
			reason: "accepted user promise",
			evidenceRef: "source-1",
			at: PROJECTED_AT,
		},
		0,
	);
	const snapshot = {
		...snapshotRef(situation, profiles.refs, projection),
		intentionRevision: store.intentionRevision(AGENT, SCOPE),
	};
	const opened = store.openRound(snapshot);
	expect(opened).toEqual({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
	});
	const assessments = (["clotho", "lachesis", "atropos"] as const).map(
		(moduleKind) => assessmentFor(snapshot, moduleKind, candidates),
	);
	for (const assessment of assessments) store.putAssessment(assessment);
	const set = store.assessmentSet(snapshot.roundId);
	const closed = buildCandidateSet({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		options: candidates,
		eligibility: candidates.map((option) => ({
			optionKey: option.optionKey,
			eligible: option.kind !== "task.start",
			reason: option.kind === "task.start" ? "infeasible precondition" : null,
		})),
		intentionRefs: [
			{
				intentionId: protectedIntention.intentionId,
				revision: protectedIntention.revision,
				status: protectedIntention.status,
				digest: intentionDigest(protectedIntention),
			},
			{
				intentionId: startIntention.intentionId,
				revision: startIntention.revision,
				status: startIntention.status,
				digest: intentionDigest(startIntention),
			},
		],
	});
	store.closeCandidateSet(closed);
	const resolved = resolvePersonalRound({
		policy: PERSONAL_POLICY_V1,
		snapshot,
		options: candidates,
		set,
		eligibility: closed.eligibility,
		bias: {},
		evidence: {
			candidates: closed,
			lookupIntention: (id) => store.getIntention(id),
		},
	});
	store.recordResolution(snapshot.roundId, resolved.resolution, resolved.spec);
	return {
		projection,
		profiles,
		options,
		candidates,
		snapshot,
		opened,
		assessments,
		resolved,
	};
}

test("autonomous personal.v1 round persists SelectionSpec and adopted intention, with injected sampling in memory", () => {
	const store = open();
	const {
		projection,
		profiles,
		options,
		candidates,
		snapshot,
		opened,
		assessments,
		resolved,
	} = playRound(store, "autonomous");

	expect(projection.workingRevision).toBe(7);
	expect(projection.instructionRevision).toBe(2);
	expect(projection.workingRevision !== projection.instructionRevision).toBe(
		true,
	);
	expect(snapshot.workingRevision !== snapshot.instructionRevision).toBe(true);
	expect(snapshot.workingRevision).toBe(projection.workingRevision);
	expect(snapshot.instructionRevision).toBe(projection.instructionRevision);

	expect(store.getObjectiveProfile("objective-clotho", 1)).toEqual(
		profiles.clotho,
	);
	expect(store.getObjectiveProfile("objective-lachesis", 1)).toEqual(
		profiles.lachesis,
	);
	expect(store.getObjectiveProfile("objective-atropos", 1)).toEqual(
		profiles.atropos,
	);
	expect(store.activeObjectiveProfiles(AGENT, SCOPE)).toEqual(profiles.refs);

	expect(options.adopt.catalogId).toBe(PERSONAL_CATALOG_ID);
	expect(parseCanonicalOption(options.inquireVariant)).toEqual(
		parseCanonicalOption(options.inquire),
	);
	expect(options.inquireVariant.optionKey).toBe(options.inquire.optionKey);
	expect(new Set(candidates.map((option) => option.optionKey)).size).toBe(4);

	expect(resolved.spec).not.toBeNull();
	if (resolved.spec === null) throw Error("expected resolved selection spec");
	const spec = resolved.spec;
	const resolution = resolved.resolution;
	expect(store.getSelectionSpec(snapshot.roundId)).toEqual(spec);
	expect(store.getResolution(snapshot.roundId)).toEqual(resolution);

	expect(p0(spec, options.start.optionKey)).toBe(0);
	expect(p0(spec, options.noop.optionKey)).toBe(0);

	expect(assessments.map((row) => row.moduleKind)).toEqual([
		"clotho",
		"lachesis",
		"atropos",
	]);
	expect(
		assessments
			.find((row) => row.moduleKind === "lachesis")
			?.objectiveAssessments.find(
				(row) => row.optionKey === options.adopt.optionKey,
			)?.stance,
	).toBe("prefer");
	expect(
		assessments
			.find((row) => row.moduleKind === "clotho")
			?.objectiveAssessments.find(
				(row) => row.optionKey === options.start.optionKey,
			),
	).toMatchObject({ stance: "oppose", severity: "infeasible" });
	expect(
		assessments
			.find((row) => row.moduleKind === "atropos")
			?.objectiveAssessments.find(
				(row) => row.optionKey === options.noop.optionKey,
			),
	).toMatchObject({ stance: "oppose", severity: "commitment_breach" });
	expect(
		resolution.ranking.find((row) => row.optionKey === options.adopt.optionKey)
			?.rank,
	).toBe(1);
	expect(
		Math.abs(spec.candidates.reduce((sum, row) => sum + row.p0, 0) - 1),
	).toBeLessThanOrEqual(1e-12);
	expect(spec.lambda).toBe(1);
	expect(spec.specDigest).toBe(
		judgmentDigest({ ...spec, specDigest: undefined }),
	);
	expect(resolution.order).toEqual([...AUTONOMOUS_ORDER]);
	expect(resolution.excluded).toContainEqual({
		optionKey: options.start.optionKey,
		stage: "host_eligibility",
		byModule: null,
		reason: "infeasible precondition",
	});
	expect(resolution.excluded).toContainEqual({
		optionKey: options.noop.optionKey,
		stage: "commitment_protection",
		byModule: "atropos",
		reason: "accepted commitment breach",
	});

	const high = sampleSelection(spec, 0.999);
	const low = sampleSelection(spec, 0.0);
	expect(p0(spec, high.optionKey)).toBeGreaterThan(0);
	expect(p0(spec, low.optionKey)).toBeGreaterThan(0);

	const proposed = proposedIntention();
	store.putIntention(proposed);
	const adoption = {
		to: "adopted" as const,
		reason: "selected by personal.v1 round",
		evidenceRef: snapshot.roundId,
		at: "2026-09-12T01:00:00.000Z",
	};
	const adopted = transitionIntention(proposed, adoption);
	expect(adopted.history[0]?.evidenceRef).toBe(snapshot.roundId);
	expect(store.transitionIntention(proposed.intentionId, adoption, 0)).toEqual(
		adopted,
	);

	close(store);
	const reopened = open();
	expect(reopened.getObjectiveProfile("objective-clotho", 1)).toEqual(
		profiles.clotho,
	);
	expect(reopened.getObjectiveProfile("objective-lachesis", 1)).toEqual(
		profiles.lachesis,
	);
	expect(reopened.getObjectiveProfile("objective-atropos", 1)).toEqual(
		profiles.atropos,
	);
	expect(reopened.activeObjectiveProfiles(AGENT, SCOPE)).toEqual(profiles.refs);
	const reopenedRound = reopened.getRound(snapshot.roundId);
	expect(reopenedRound).toEqual({
		snapshot,
		status: "resolved",
		snapshotDigest: opened.snapshotDigest,
	});
	expect(reopenedRound?.snapshot).toEqual(snapshot);
	expect(reopenedRound?.snapshot.roundId).toBe(opened.roundId);
	expect(reopenedRound?.snapshot.situation).toBe("autonomous");
	expect(reopenedRound?.snapshotDigest).toBe(snapshotDigest(snapshot));
	expect(reopenedRound?.status).toBe("resolved");
	expect(
		sortedAssessments(reopened.assessmentSet(snapshot.roundId).assessments),
	).toEqual(sortedAssessments(assessments));
	expect(reopened.getResolution(snapshot.roundId)).toEqual(resolution);
	expect(reopened.getResolution(snapshot.roundId, "action")?.order).toEqual([
		...AUTONOMOUS_ORDER,
	]);
	expect(reopened.getSelectionSpec(snapshot.roundId)).toEqual(spec);
	expect(reopened.getIntention(proposed.intentionId)).toEqual(adopted);
});

test("user_request personal.v1 round sets lambda 0 and atropos-first order", () => {
	const store = open();
	const { snapshot } = playRound(store, "user_request");
	const spec = store.getSelectionSpec(snapshot.roundId);
	const resolution = store.getResolution(snapshot.roundId, "action");
	expect(spec).not.toBeNull();
	expect(resolution).not.toBeNull();
	if (spec === null || resolution === null)
		throw Error("missing resolution artifacts");
	expect(spec.lambda).toBe(0);
	expect(resolution.order[0]).toBe("atropos");
});
