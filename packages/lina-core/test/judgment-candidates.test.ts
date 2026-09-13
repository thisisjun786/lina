import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	assessmentInputDigest,
	buildCandidateSet,
	buildCanonicalOption,
	type CandidateSet,
	type CanonicalOption,
	type IntentionRecord,
	intentionDigest,
	type JudgmentSnapshotRef,
	JudgmentStore,
	judgmentDigest,
	MODULE_KINDS,
	PERSONAL_POLICY_V1,
	parseAssessment,
	parseCandidateSet,
	parseIntentionRecord,
	parseResolutionRecord,
	parseSelectionSpec,
	resolvePersonalRound,
	snapshotDigest,
} from "../src/agents/index.ts";
import { Fixture } from "./fixture.ts";

let fixture: Fixture;
let store: JudgmentStore;
let path: string;
let snapshot: JudgmentSnapshotRef;
const actor = { agentId: "agent-1", scopeId: "scope-1" };
const at = "2026-09-12T00:00:00.000Z";
function option(reason = "one"): CanonicalOption {
	return buildCanonicalOption({
		kind: "noop",
		actor,
		targetId: null,
		args: {},
		preconditions: { kind: "noop", reason },
	});
}
function openFixtureRound(): void {
	if (store.getRound(snapshot.roundId)) return;
	snapshot = {
		...snapshot,
		intentionRevision: store.intentionRevision(actor.agentId, actor.scopeId),
	};
	store.openRound(snapshot);
}
function candidate(
	options = [option()],
	intentionRefs: CandidateSet["intentionRefs"] = [],
): CandidateSet {
	openFixtureRound();
	return buildCandidateSet({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		options,
		eligibility: options.map((o) => ({
			optionKey: o.optionKey,
			eligible: true,
			reason: null,
		})),
		intentionRefs,
	});
}
function intention(id = "intention-1"): IntentionRecord {
	return parseIntentionRecord({
		schemaVersion: 1,
		intentionId: id,
		...actor,
		revision: 0,
		kind: "user_commitment",
		purposeRef: "purpose",
		text: "Keep commitment",
		acceptance: {
			sourceRef: "request-1",
			acceptedBy: "user",
			policyRevision: 1,
			acceptedAt: at,
		},
		priority: 0,
		deadline: null,
		completionCondition: "receipt",
		abortConditions: [],
		relatedIntentions: [],
		status: "proposed",
		history: [],
	});
}
function transition(
	id: string,
	to: IntentionRecord["status"],
	revision: number,
) {
	return store.transitionIntention(
		id,
		{ to, reason: "transition", evidenceRef: "request-1", at },
		revision,
	);
}
function intentionRef(
	record: IntentionRecord,
): CandidateSet["intentionRefs"][number] {
	return {
		intentionId: record.intentionId,
		revision: record.revision,
		status: record.status,
		digest: intentionDigest(record),
	};
}
function assess(options = [option()], breachIds?: string[]) {
	openFixtureRound();
	for (const moduleKind of MODULE_KINDS) {
		const input = {
			snapshotDigest: snapshotDigest(snapshot),
			objectiveRef: snapshot.objectiveProfileRefs[moduleKind],
			mechanismRevision: 1,
		};
		store.putAssessment(
			parseAssessment({
				schemaVersion: 1,
				moduleKind,
				snapshotId: snapshot.roundId,
				...input,
				inputDigest: assessmentInputDigest(input),
				completeText: "Assessment",
				evidenceRefs: [],
				proposedOptionKeys: [],
				recommendedOptionKeys: [],
				objectiveAssessments: options.map((o) => ({
					optionKey: o.optionKey,
					stance: breachIds && moduleKind === "atropos" ? "oppose" : "accept",
					severity:
						breachIds && moduleKind === "atropos" ? "commitment_breach" : null,
					unavailableReason: null,
					gain: "gain",
					loss: "loss",
					uncertainty: "uncertainty",
					evidenceRefs: [],
					...(breachIds && moduleKind === "atropos"
						? { breachedIntentionIds: breachIds }
						: {}),
				})),
				detail: {
					kind: {
						clotho: "forecasts",
						lachesis: "values",
						atropos: "continuity",
					}[moduleKind],
					body: {},
				},
				diagnostics: {},
			}),
		);
	}
}
function resolve(set: CandidateSet) {
	return resolvePersonalRound({
		policy: PERSONAL_POLICY_V1,
		snapshot,
		options: set.options,
		eligibility: set.eligibility,
		set: store.assessmentSet(snapshot.roundId),
		bias: {},
		evidence: {
			candidates: set,
			lookupIntention: (id) => store.getIntention(id),
		},
	});
}
function reopen() {
	store.close();
	store = new JudgmentStore(path);
}
function db() {
	return fixture.keep(new DatabaseSync(path));
}
function rehash(set: CandidateSet) {
	return parseCandidateSet({
		...set,
		candidateDigest: judgmentDigest({ ...set, candidateDigest: undefined }),
	});
}
function held() {
	openFixtureRound();
	return parseResolutionRecord({
		schemaVersion: 1,
		roundId: snapshot.roundId,
		policyId: snapshot.policyId,
		policyRevision: snapshot.policyRevision,
		situation: snapshot.situation,
		order: ["atropos", "clotho", "lachesis"],
		recommendations: { clotho: [], lachesis: [], atropos: [] },
		conflicts: [],
		excluded: [],
		abstentions: [],
		ranking: [],
		conceded: [],
		status: "held",
		holdReason: "missing evidence",
	});
}
beforeEach(() => {
	fixture = new Fixture();
	path = join(fixture.dir, "judgment.sqlite");
	store = new JudgmentStore(path, { now: () => 1234 });
	for (const moduleKind of MODULE_KINDS) {
		const ref = store.putObjectiveProfile({
			schemaVersion: 1,
			objectiveId: moduleKind,
			moduleKind,
			revision: 1,
			objective: "Compare",
			comparisonCriteria: [],
			reconsiderationConditions: [],
		});
		store.activateObjectiveProfile(actor.agentId, actor.scopeId, ref);
	}
	const refs = store.activeObjectiveProfiles(actor.agentId, actor.scopeId);
	if (!refs) throw Error("missing fixture profiles");
	snapshot = {
		schemaVersion: 1,
		roundId: "round-1",
		...actor,
		sourceRefs: [],
		workingRevision: 0,
		instructionRevision: 0,
		policyId: "personal.v1",
		policyRevision: 1,
		identityRevision: 0,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "user_request",
		clockId: "clock",
		sequence: 1,
		bindingGeneration: 0,
	};
});
afterEach(() => {
	store.close();
	fixture.close();
});

test("candidate builder sorts canonical options and refs but preserves exact Host eligibility order and missing rows", () => {
	const a = option("a"),
		b = option("b");
	const original = candidate([a, b]);
	const reversed = buildCandidateSet({
		roundId: original.roundId,
		snapshotDigest: original.snapshotDigest,
		options: [b, a],
		eligibility: [...original.eligibility].reverse(),
		intentionRefs: [],
	});
	expect(reversed.options).toEqual(original.options);
	expect(
		parseCandidateSet({
			...original,
			options: [...original.options].reverse(),
		}),
	).toEqual(original);
	const refs = candidate(
		[a],
		[intentionRef(intention("b")), intentionRef(intention("a"))],
	);
	expect(refs.intentionRefs.map((r) => r.intentionId)).toEqual(["a", "b"]);
	expect(reversed.eligibility).toEqual([...original.eligibility].reverse());
	expect(reversed.candidateDigest).not.toBe(original.candidateDigest);
	expect(parseCandidateSet(JSON.parse(JSON.stringify(original)))).toEqual(
		original,
	);
	const missing = buildCandidateSet({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		options: [a, b],
		eligibility: [],
		intentionRefs: [],
	});
	expect(missing.eligibility).toEqual([]);
	store.closeCandidateSet(missing);
	assess([a, b]);
	const result = resolve(missing);
	expect(result.resolution.status).toBe("deferred");
	store.recordResolution(snapshot.roundId, result.resolution, result.spec);
	reopen();
	expect(store.candidateSet(snapshot.roundId)).toEqual(missing);
	expect(store.getResolution(snapshot.roundId)).toEqual(result.resolution);
});

test("candidate parser rejects unknown, duplicate, malformed and foreign input without normalizing Host semantics", () => {
	const set = candidate();
	for (const changed of [
		{ ...set, schemaVersion: 2 },
		{ ...set, extra: true },
		{ ...set, candidateDigest: "forged" },
		{ ...set, options: [option(), option()] },
		{ ...set, options: [{ ...option(), optionKey: "forged" }] },
		{ ...set, eligibility: [...set.eligibility, ...set.eligibility] },
		{
			...set,
			eligibility: [{ optionKey: "foreign", eligible: true, reason: null }],
		},
		{
			...set,
			eligibility: [
				{ optionKey: option().optionKey, eligible: "true", reason: null },
			],
		},
		{
			...set,
			eligibility: [{ optionKey: option().optionKey, eligible: false }],
		},
		{
			...set,
			intentionRefs: [intentionRef(intention()), intentionRef(intention())],
		},
		{ ...set, intentionRefs: [{ ...intentionRef(intention()), revision: -1 }] },
		{ ...set, intentionRefs: [{ ...intentionRef(intention()), extra: true }] },
	])
		expect(() => parseCandidateSet(changed)).toThrow();
	const foreign = buildCanonicalOption({
		...option("foreign"),
		actor: { ...actor, scopeId: "foreign" },
	});
	expect(() => candidate([option(), foreign])).toThrow(
		"candidate actor mismatch",
	);
});

test("closure requires an open matching frozen round and is immutable and detached", () => {
	expect(store.candidateSet(snapshot.roundId)).toBeNull();
	for (const changed of [
		rehash({ ...candidate(), roundId: "missing" }),
		rehash({ ...candidate(), snapshotDigest: "wrong" }),
		candidate([
			buildCanonicalOption({
				...option(),
				actor: { ...actor, agentId: "foreign" },
			}),
		]),
	])
		expect(() => store.closeCandidateSet(changed)).toThrow();
	const set = candidate();
	store.closeCandidateSet(set);
	expect(() => store.closeCandidateSet(set)).toThrow(
		"candidate set already closed",
	);
	set.eligibility.length = 0;
	expect(store.candidateSet(snapshot.roundId)).toEqual(candidate());
	store.recordResolution(snapshot.roundId, held(), null);
	expect(() => store.closeCandidateSet(candidate())).toThrow(
		"judgment round is not open",
	);
	reopen();
	expect(store.candidateSet(snapshot.roundId)).toEqual(candidate());
});

for (const complete of [false, true])
	for (const status of ["held", "deferred"] as const)
		test(`${status}/no-spec can record missing candidate evidence (assessments complete=${complete})`, () => {
			if (complete) assess();
			const record = { ...held(), status };
			expect(() =>
				parseResolutionRecord({ ...held(), status: "invalidated" }),
			).toThrow();
			store.recordResolution(snapshot.roundId, record, null);
			expect(() =>
				store.recordResolution(snapshot.roundId, record, null),
			).toThrow("judgment round is not open");
			reopen();
			expect(store.getResolution(snapshot.roundId)).toEqual(record);
			expect(store.getSelectionSpec(snapshot.roundId)).toBeNull();
		});

test("complete inputs replay held and deferred, rejecting descriptive mutations atomically", () => {
	const set = candidate();
	store.closeCandidateSet(set);
	assess([]);
	const result = resolve(set);
	expect(result.resolution.status).toBe("held");
	expect(() =>
		store.recordResolution(
			snapshot.roundId,
			{ ...result.resolution, status: "deferred" },
			null,
		),
	).toThrow("resolution policy replay mismatch");
	expect(store.getRound(snapshot.roundId)?.status).toBe("open");
	store.recordResolution(snapshot.roundId, result.resolution, null);
	db()
		.prepare("UPDATE resolution_records SET body = ?, digest = ?")
		.run(JSON.stringify(held()), judgmentDigest(held()));
	expect(() => store.getResolution(snapshot.roundId)).toThrow(
		"resolution policy replay mismatch",
	);
});

for (const stage of [
	"infeasible",
	"commitment_protection",
	"host_eligibility",
] as const) {
	for (const persisted of [false, true])
		test(`closed all-accept inputs reject fully rehashed ${stage} exclusion (persisted=${persisted})`, () => {
			const set = candidate([option("a"), option("b")]);
			store.closeCandidateSet(set);
			assess(set.options);
			const result = resolve(set);
			const spec = result.spec;
			if (!spec) throw Error("missing spec");
			const [first, second] = set.options;
			if (!first || !second) throw Error("missing options");
			const forged = parseResolutionRecord({
				...result.resolution,
				ranking: [{ optionKey: first.optionKey, rank: 1 }],
				excluded: [
					{
						optionKey: second.optionKey,
						stage,
						byModule:
							stage === "infeasible"
								? "clotho"
								: stage === "commitment_protection"
									? "atropos"
									: null,
						reason: "forged",
					},
				],
			});
			const changed = {
				...spec,
				resolutionDigest: judgmentDigest(forged),
				candidates: spec.candidates.map((c) => ({
					...c,
					p0: c.optionKey === first.optionKey ? 1 : 0,
				})),
				eligibleDigest: judgmentDigest([first.optionKey]),
			};
			const forgedSpec = parseSelectionSpec({
				...changed,
				specDigest: judgmentDigest({ ...changed, specDigest: undefined }),
			});
			if (persisted) {
				store.recordResolution(snapshot.roundId, result.resolution, spec);
				const sql = db();
				sql
					.prepare("UPDATE resolution_records SET body = ?, digest = ?")
					.run(JSON.stringify(forged), judgmentDigest(forged));
				sql
					.prepare("UPDATE selection_specs SET body = ?, spec_digest = ?")
					.run(JSON.stringify(forgedSpec), forgedSpec.specDigest);
				expect(() => store.getResolution(snapshot.roundId)).toThrow(
					"resolution policy replay mismatch",
				);
				reopen();
				expect(() => store.getSelectionSpec(snapshot.roundId)).toThrow(
					"resolution policy replay mismatch",
				);
			} else {
				expect(() =>
					store.recordResolution(snapshot.roundId, forged, forgedSpec),
				).toThrow("resolution policy replay mismatch");
				expect(store.getResolution(snapshot.roundId)).toBeNull();
				expect(store.getRound(snapshot.roundId)?.status).toBe("open");
				store.recordResolution(snapshot.roundId, result.resolution, spec);
			}
		});
}

for (const column of [
	"round_id",
	"snapshot_digest",
	"candidate_digest",
	"body",
	"delete",
] as const)
	test(`candidate audit detects ${column} tampering on external commit and reopen`, () => {
		const set = candidate();
		store.closeCandidateSet(set);
		assess();
		const result = resolve(set);
		store.recordResolution(snapshot.roundId, result.resolution, result.spec);
		const sql = db();
		sql.exec("PRAGMA foreign_keys = OFF");
		if (column === "delete") sql.exec("DELETE FROM candidate_sets");
		else
			sql
				.prepare(`UPDATE candidate_sets SET ${column} = ?`)
				.run(
					column === "body"
						? JSON.stringify({ ...set, eligibility: [] })
						: "forged",
				);
		expect(() => store.getRound(snapshot.roundId)).toThrow();
		reopen();
		expect(() => store.candidateSet(snapshot.roundId)).toThrow();
	});

function suspend(id = "intention-1", acceptanceSourceRef = "request-1") {
	return buildCanonicalOption({
		kind: "intention.suspend",
		actor,
		targetId: id,
		args: {},
		preconditions: {
			kind: "intention.suspend",
			intentionId: id,
			acceptanceSourceRef,
			reason: "pause",
		},
	});
}

test("eligible intention targets require matching current scoped references, acceptance and legal transition", () => {
	store.putIntention(intention());
	const adopted = transition("intention-1", "adopted", 0);
	const active = transition("intention-1", "active", 1);
	store.putIntention({ ...intention("foreign"), scopeId: "foreign" });
	for (const set of [
		candidate([suspend()]),
		candidate([suspend()], [intentionRef(adopted)]),
		candidate([suspend()], [{ ...intentionRef(active), digest: "wrong" }]),
		candidate([suspend()], [{ ...intentionRef(active), status: "suspended" }]),
		candidate(
			[suspend("missing")],
			[{ ...intentionRef(active), intentionId: "missing" }],
		),
		candidate(
			[suspend("foreign")],
			[intentionRef({ ...intention("foreign"), scopeId: "foreign" })],
		),
		candidate([suspend("intention-1", "fabricated")], [intentionRef(active)]),
		candidate(
			[
				buildCanonicalOption({
					kind: "intention.resume",
					actor,
					targetId: active.intentionId,
					args: {},
					preconditions: {
						kind: "intention.resume",
						intentionId: active.intentionId,
						acceptanceSourceRef: "request-1",
						reason: "resume",
					},
				}),
			],
			[intentionRef(active)],
		),
	]) {
		expect(() => store.closeCandidateSet(set)).toThrow();
		expect(store.candidateSet(snapshot.roundId)).toBeNull();
	}
	store.closeCandidateSet(candidate([suspend()], [intentionRef(active)]));
});

for (const tamper of ["none", "metadata", "acceptance", "delete"] as const)
	test(`frozen intention revision survives valid later transitions but rejects ${tamper} rewrite`, () => {
		store.putIntention(intention());
		transition("intention-1", "adopted", 0);
		const active = transition("intention-1", "active", 1);
		const set = candidate([suspend()], [intentionRef(active)]);
		store.closeCandidateSet(set);
		assess(set.options);
		const result = resolve(set);
		store.recordResolution(snapshot.roundId, result.resolution, result.spec);
		transition("intention-1", "suspended", 2);
		transition("intention-1", "active", 3);
		const current = transition("intention-1", "completed", 4);
		const sql = db();
		if (tamper === "none") {
			reopen();
			expect(store.candidateSet(snapshot.roundId)).toEqual(set);
			expect(store.getResolution(snapshot.roundId)).toEqual(result.resolution);
			expect(store.getIntention(current.intentionId)).toEqual(current);
			return;
		}
		if (tamper === "delete")
			sql.exec(
				"PRAGMA foreign_keys = OFF; DELETE FROM intention_transitions; DELETE FROM intention_records",
			);
		else {
			const changed = parseIntentionRecord(
				tamper === "metadata"
					? { ...current, text: "replacement" }
					: {
							...current,
							acceptance: {
								...current.acceptance,
								acceptedAt: "2026-09-11T00:00:00.000Z",
							},
						},
			);
			sql
				.prepare("UPDATE intention_records SET body = ?, digest = ?")
				.run(JSON.stringify(changed), intentionDigest(changed));
		}
		expect(() => store.getResolution(snapshot.roundId)).toThrow(
			/candidate intention/,
		);
		reopen();
		expect(() => store.candidateSet(snapshot.roundId)).toThrow(
			/candidate intention/,
		);
	});

test("candidate insertion failure rolls back closure and leaves the round open", () => {
	const sql = db();
	sql.exec(
		"CREATE TRIGGER fail_candidate BEFORE INSERT ON candidate_sets BEGIN SELECT RAISE(ABORT, 'fixture candidate failure'); END",
	);
	expect(() => store.closeCandidateSet(candidate())).toThrow(
		"fixture candidate failure",
	);
	expect(store.candidateSet(snapshot.roundId)).toBeNull();
	expect(store.getRound(snapshot.roundId)?.status).toBe("open");
	sql.exec("DROP TRIGGER fail_candidate");
	store.closeCandidateSet(candidate());
	expect(store.candidateSet(snapshot.roundId)).toEqual(candidate());
});

test("rehashed candidate input tampering must agree with the persisted policy outcome", () => {
	const set = candidate();
	store.closeCandidateSet(set);
	assess();
	const result = resolve(set);
	store.recordResolution(snapshot.roundId, result.resolution, result.spec);
	const changed = rehash({ ...set, eligibility: [] });
	db()
		.prepare("UPDATE candidate_sets SET body = ?, candidate_digest = ?")
		.run(JSON.stringify(changed), changed.candidateDigest);
	expect(() => store.getResolution(snapshot.roundId)).toThrow(
		"resolution policy replay mismatch",
	);
	reopen();
	expect(() => store.candidateSet(snapshot.roundId)).toThrow(
		"resolution policy replay mismatch",
	);
});

test("complete replay binds conflicts, recommendations, abstentions, concessions and ordering", () => {
	const set = candidate();
	store.closeCandidateSet(set);
	assess();
	const result = resolve(set);
	if (!result.spec) throw Error("missing spec");
	const key = option().optionKey;
	for (const change of [
		{
			conflicts: [
				{
					optionKey: key,
					stances: { clotho: "prefer", lachesis: "accept", atropos: "accept" },
				},
			],
		},
		{ recommendations: { clotho: [key], lachesis: [], atropos: [] } },
		{
			abstentions: [
				{ optionKey: key, moduleKind: "clotho", reason: "fabricated" },
			],
		},
		{ conceded: [{ optionKey: key, moduleKind: "atropos" }] },
		{ order: ["clotho", "atropos", "lachesis"] },
	]) {
		const record = parseResolutionRecord({ ...result.resolution, ...change });
		const spec = { ...result.spec, resolutionDigest: judgmentDigest(record) };
		const selection = parseSelectionSpec({
			...spec,
			specDigest: judgmentDigest({ ...spec, specDigest: undefined }),
		});
		expect(() =>
			store.recordResolution(snapshot.roundId, record, selection),
		).toThrow("resolution policy replay mismatch");
		expect(store.getResolution(snapshot.roundId)).toBeNull();
	}
	const spec = {
		...result.spec,
		candidates: result.spec.candidates.map((c) => ({ ...c, b: 0.75 })),
	};
	const selection = parseSelectionSpec({
		...spec,
		specDigest: judgmentDigest({ ...spec, specDigest: undefined }),
	});
	store.recordResolution(snapshot.roundId, result.resolution, selection);
	reopen();
	expect(store.getSelectionSpec(snapshot.roundId)).toEqual(selection);
});

test("historical evidence rejects rewritten original acceptance even with a consistent current history ledger", () => {
	store.putIntention(intention());
	transition("intention-1", "adopted", 0);
	const active = transition("intention-1", "active", 1);
	store.closeCandidateSet(candidate([suspend()], [intentionRef(active)]));
	const suspended = transition("intention-1", "suspended", 2);
	const changed = parseIntentionRecord({
		...suspended,
		acceptance: { ...suspended.acceptance, sourceRef: "replacement" },
		history: suspended.history.map((t) => ({
			...t,
			evidenceRef: "replacement",
		})),
	});
	const sql = db();
	sql
		.prepare("UPDATE intention_records SET body = ?, digest = ?")
		.run(JSON.stringify(changed), intentionDigest(changed));
	sql.exec("UPDATE intention_transitions SET evidence_ref = 'replacement'");
	expect(() => store.candidateSet(snapshot.roundId)).toThrow(
		"candidate intention digest mismatch",
	);
	reopen();
	expect(() => store.getIntention("intention-1")).toThrow(
		"candidate intention digest mismatch",
	);
});

test("eligible resume references the suspended intention and original acceptance when present", () => {
	store.putIntention(intention());
	transition("intention-1", "adopted", 0);
	const suspended = transition("intention-1", "suspended", 1);
	const resume = buildCanonicalOption({
		kind: "intention.resume",
		actor,
		targetId: suspended.intentionId,
		args: {},
		preconditions: {
			kind: "intention.resume",
			intentionId: suspended.intentionId,
			acceptanceSourceRef: "request-1",
			reason: "resume",
		},
	});
	const set = candidate([resume], [intentionRef(suspended)]);
	store.closeCandidateSet(set);
	assess(set.options);
	const result = resolve(set);
	store.recordResolution(snapshot.roundId, result.resolution, result.spec);
	transition(suspended.intentionId, "active", 2);
	reopen();
	expect(store.candidateSet(snapshot.roundId)).toEqual(set);
});

test("Atropos attributed breach evidence is required whether assessments arrive before or after closure", () => {
	assess([option()], ["missing"]);
	expect(() => store.closeCandidateSet(candidate())).toThrow(
		"missing protected commitment evidence",
	);
	expect(store.candidateSet(snapshot.roundId)).toBeNull();
});

for (const kind of ["user_commitment", "autonomous_goal"] as const)
	for (const status of ["proposed", "active"] as const)
		test(`attributed protected evidence requires accepted live user commitment (${kind}/${status})`, () => {
			const proposed = { ...intention(), kind };
			store.putIntention(proposed);
			let record: IntentionRecord = proposed;
			if (status === "active") {
				transition(record.intentionId, "adopted", 0);
				record = transition(record.intentionId, "active", 1);
			}
			const set = candidate([option()], [intentionRef(record)]);
			store.closeCandidateSet(set);
			if (kind !== "user_commitment" || status !== "active")
				expect(() => assess(set.options, [record.intentionId])).toThrow(
					"missing protected commitment evidence",
				);
			else {
				assess(set.options, [record.intentionId]);
				const result = resolve(set);
				expect(result.resolution.status).toBe("deferred");
				store.recordResolution(
					snapshot.roundId,
					result.resolution,
					result.spec,
				);
				reopen();
				expect(store.getResolution(snapshot.roundId)).toEqual(
					result.resolution,
				);
			}
		});

test("targeted waiver with verified protected intention is replayed and remains historical", () => {
	store.putIntention(intention());
	transition("intention-1", "adopted", 0);
	const active = transition("intention-1", "active", 1);
	const set = candidate([suspend()], [intentionRef(active)]);
	assess(set.options, [active.intentionId]);
	store.closeCandidateSet(set);
	const result = resolve(set);
	expect(result.resolution.status).toBe("resolved");
	store.recordResolution(snapshot.roundId, result.resolution, result.spec);
	transition(active.intentionId, "suspended", 2);
	reopen();
	expect(store.getSelectionSpec(snapshot.roundId)).toEqual(result.spec);
});
