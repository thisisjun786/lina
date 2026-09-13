import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	ACCEPTED_BY,
	type Assessment,
	assessmentInputDigest,
	EXCLUSION_STAGES,
	INTENTION_KINDS,
	INTENTION_RELATIONS,
	INTENTION_STATUSES,
	INTENTION_TRANSITIONS,
	type IntentionRecord,
	intentionDigest,
	type JudgmentSnapshotRef,
	judgmentDigest,
	MODULE_KINDS,
	type ModuleKind,
	type ObjectiveProfile,
	type OptionAssessment,
	parseAssessment,
	parseAssessmentSet,
	parseIntentionRecord,
	parseIntentionTransition,
	parseJudgmentSnapshotRef,
	parseObjectiveProfile,
	parseOptionAssessment,
	parseResolutionRecord,
	parseSelectionSpec,
	type ResolutionRecord,
	ROUND_STATUSES,
	SEVERITIES,
	type SelectionSpec,
	SITUATIONS,
	STANCES,
	snapshotDigest,
	transitionIntention,
} from "../src/agents/index.ts";

const profile: ObjectiveProfile = {
	schemaVersion: 1,
	objectiveId: "objective-clotho",
	moduleKind: "clotho",
	revision: 1,
	objective: "Compare fixture outcomes",
	comparisonCriteria: ["cost", "outcome"],
	reconsiderationConditions: ["new evidence"],
};
const snapshot: JudgmentSnapshotRef = {
	schemaVersion: 1,
	roundId: "round-1",
	agentId: "agent-1",
	scopeId: "scope-1",
	sourceRefs: [{ kind: "request", id: "request-1", revision: 0 }],
	workingRevision: 2,
	instructionRevision: 1,
	policyId: "personal.v1",
	policyRevision: 1,
	identityRevision: 1,
	domainRevisions: { life: 0 },
	intentionRevision: 0,
	objectiveProfileRefs: {
		clotho: {
			objectiveId: "objective-clotho",
			revision: 1,
			digest: "profile-digest",
		},
		lachesis: {
			objectiveId: "objective-lachesis",
			revision: 1,
			digest: "profile-digest",
		},
		atropos: {
			objectiveId: "objective-atropos",
			revision: 1,
			digest: "profile-digest",
		},
	},
	observationRef: null,
	frozenNeuralRef: null,
	situation: "user_request",
	clockId: "clock-1",
	sequence: 0,
	bindingGeneration: 0,
};
const option: OptionAssessment = {
	optionKey: "a",
	stance: "prefer",
	severity: null,
	unavailableReason: null,
	gain: "fixture gain",
	loss: "fixture loss",
	uncertainty: "fixture uncertainty",
	evidenceRefs: ["evidence-1"],
};
const assessment: Assessment = {
	schemaVersion: 1,
	moduleKind: "clotho",
	snapshotId: "round-1",
	snapshotDigest: "snapshot-digest",
	inputDigest:
		"8a5ceb71d411139b4ad10b5d5a8e78045ae9b788fd3fb9d64bf4c440094504e7",
	objectiveRef: {
		objectiveId: "objective-clotho",
		revision: 1,
		digest: "profile-digest",
	},
	mechanismRevision: 1,
	completeText: "Fixture forecast",
	evidenceRefs: ["evidence-1"],
	proposedOptionKeys: ["a"],
	objectiveAssessments: [
		{
			optionKey: "a",
			stance: "prefer",
			severity: null,
			unavailableReason: null,
			gain: "fixture gain",
			loss: "fixture loss",
			uncertainty: "fixture uncertainty",
			evidenceRefs: ["evidence-1"],
		},
	],
	recommendedOptionKeys: ["a"],
	detail: {
		kind: "forecasts",
		body: { forecast: [null, true, 1, "outcome", { possible: false }] },
	},
	diagnostics: {},
};
const spec: SelectionSpec = {
	schemaVersion: 1,
	roundId: "round-1",
	snapshotDigest: "snapshot-digest",
	assessmentSetDigest: "set-digest",
	objectiveProfileRefs: {
		clotho: {
			objectiveId: "objective-clotho",
			revision: 1,
			digest: "profile-digest",
		},
		lachesis: {
			objectiveId: "objective-lachesis",
			revision: 1,
			digest: "profile-digest",
		},
		atropos: {
			objectiveId: "objective-atropos",
			revision: 1,
			digest: "profile-digest",
		},
	},
	resolutionDigest: "resolution-digest",
	policyId: "personal.v1",
	policyRevision: 1,
	situation: "user_request",
	lambda: 0,
	candidates: [
		{ optionKey: "a", p0: 0.5, b: null },
		{ optionKey: "b", p0: 0.5, b: 1 },
	],
	eligibleDigest:
		"0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13",
	specDigest:
		"1ec632276bd8febd508ce2d47ae110e4fb029b94777d97aeafdfff43e00aecc7",
};
const intention: IntentionRecord = {
	schemaVersion: 1,
	intentionId: "intention-1",
	agentId: "agent-1",
	scopeId: "scope-1",
	revision: 0,
	kind: "user_commitment",
	purposeRef: "purpose-1",
	text: "Complete fixture task",
	acceptance: {
		sourceRef: "request-1",
		acceptedBy: "user",
		policyRevision: 1,
		acceptedAt: "2026-09-11T00:00:00.000Z",
	},
	priority: 0,
	deadline: null,
	completionCondition: "Outcome receipt",
	abortConditions: ["request withdrawn"],
	relatedIntentions: [{ intentionId: "intention-2", relation: "depends" }],
	status: "proposed",
	history: [],
};
const transition = {
	from: "proposed",
	to: "adopted",
	reason: "accepted",
	evidenceRef: null,
	at: "2026-09-11T01:00:00.000Z",
} as const;
const resolution: ResolutionRecord = {
	schemaVersion: 1,
	roundId: "round-1",
	policyId: "personal.v1",
	policyRevision: 1,
	situation: "user_request",
	order: ["atropos", "clotho", "lachesis"],
	recommendations: { clotho: ["a"], lachesis: [], atropos: ["b"] },
	conflicts: [
		{
			optionKey: "a",
			stances: { clotho: "prefer", lachesis: "unavailable", atropos: "oppose" },
		},
	],
	excluded: [
		{
			optionKey: "b",
			stage: "commitment_protection",
			byModule: "atropos",
			reason: "acceptance protected",
		},
	],
	abstentions: [
		{ optionKey: "a", moduleKind: "lachesis", reason: "missing observation" },
	],
	ranking: [{ optionKey: "a", rank: 1 }],
	conceded: [{ moduleKind: "atropos", optionKey: "b" }],
	status: "resolved",
	holdReason: null,
};
function moduleAssessment(moduleKind: ModuleKind): Assessment {
	const objectiveRef = snapshot.objectiveProfileRefs[moduleKind];
	return parseAssessment({
		...assessment,
		moduleKind,
		objectiveRef,
		inputDigest: assessmentInputDigest({
			snapshotDigest: assessment.snapshotDigest,
			objectiveRef,
			mechanismRevision: 1,
		}),
		detail: {
			kind: { clotho: "forecasts", lachesis: "values", atropos: "continuity" }[
				moduleKind
			],
			body: {},
		},
	});
}
function assessmentSet() {
	return {
		schemaVersion: 1,
		roundId: "round-1",
		snapshotDigest: "snapshot-digest",
		assessments: MODULE_KINDS.map(moduleAssessment),
	};
}
function signedSpec(changes: Partial<SelectionSpec>): SelectionSpec {
	const changed = { ...spec, ...changes };
	return {
		...changed,
		eligibleDigest: judgmentDigest(
			changed.candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
		),
		specDigest: judgmentDigest({
			...changed,
			eligibleDigest: judgmentDigest(
				changed.candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
			),
			specDigest: undefined,
		}),
	};
}
const topLevel: Array<[string, (value: unknown) => unknown, () => object]> = [
	["objective profile", parseObjectiveProfile, () => profile],
	["judgment snapshot ref", parseJudgmentSnapshotRef, () => snapshot],
	["assessment", parseAssessment, () => assessment],
	["assessment set", parseAssessmentSet, assessmentSet],
	["resolution record", parseResolutionRecord, () => resolution],
	["selection spec", parseSelectionSpec, () => spec],
	["intention record", parseIntentionRecord, () => intention],
];
for (const [label, parse, golden] of topLevel) {
	test(`${label}: golden JSON round-trip and version-first rejection`, () => {
		const json = JSON.stringify(golden());
		expect(JSON.stringify(parse(JSON.parse(json)))).toBe(json);
		for (const schemaVersion of [0, 2])
			expect(() => parse({ ...golden(), schemaVersion, extra: true })).toThrow(
				/Unsupported .* schema version/,
			);
		expect(() => parse({ ...golden(), extra: true })).toThrow(
			/unknown .* field extra/,
		);
		for (const bad of [null, [], "record", 1])
			expect(() => parse(bad)).toThrow();
	});
}

test("nested records have no schema version", () => {
	for (const [parse, value] of [
		[parseOptionAssessment, option],
		[parseIntentionTransition, transition],
	] as const) {
		expect(parse(value)).toEqual(value);
		expect(() => parse({ ...value, schemaVersion: 1 })).toThrow(
			/unknown .* field schemaVersion/,
		);
		expect(() => parse(null)).toThrow();
	}
});

test("declared vocabulary is exported without adding numeric assessment scores", () => {
	expect(MODULE_KINDS).toEqual(["clotho", "lachesis", "atropos"]);
	expect(STANCES).toEqual(["prefer", "accept", "oppose", "unavailable"]);
	expect(SEVERITIES).toEqual(["commitment_breach", "infeasible", "preference"]);
	expect(SITUATIONS).toEqual(["user_request", "autonomous", "transition"]);
	expect(INTENTION_KINDS).toEqual([
		"user_commitment",
		"autonomous_goal",
		"task_binding",
	]);
	expect(INTENTION_STATUSES).toEqual([
		"proposed",
		"adopted",
		"active",
		"suspended",
		"completed",
		"cancelled",
	]);
	expect(INTENTION_RELATIONS).toEqual(["depends", "conflicts", "supersedes"]);
	expect(ACCEPTED_BY).toEqual(["user", "host_autonomy"]);
	expect(ROUND_STATUSES).toEqual(["open", "resolved", "deferred", "held"]);
	expect(EXCLUSION_STAGES).toEqual([
		"host_eligibility",
		"commitment_protection",
		"infeasible",
	]);
	expect(() => parseOptionAssessment({ ...option, score: 1 })).toThrow(
		/unknown/,
	);
});

test("digests canonicalize nested object keys, preserve arrays, and omit undefined fields", () => {
	expect(judgmentDigest({ a: 1, b: [{ d: 1, c: 2 }] })).toBe(
		judgmentDigest({ b: [{ c: 2, d: 1 }], a: 1 }),
	);
	expect(judgmentDigest([1, 2])).not.toBe(judgmentDigest([2, 1]));
	expect(judgmentDigest({ a: 1, b: undefined })).toBe(judgmentDigest({ a: 1 }));
	expect(snapshotDigest(snapshot)).toBe(judgmentDigest(snapshot));
	expect(intentionDigest(intention)).toBe(judgmentDigest(intention));
	expect(judgmentDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
	expect(assessmentInputDigest(assessment)).toBe(assessment.inputDigest);
});

test("canonical JSON rejects unsupported top-level values", () => {
	for (const value of [undefined, () => 1, Symbol("value"), 1n])
		expect(() => judgmentDigest(value)).toThrow("unsupported canonical value");
});

test("canonical JSON bounds nesting and rejects cycles clearly", () => {
	let value: unknown = null;
	for (let depth = 0; depth < 64; depth += 1) value = [value];
	expect(judgmentDigest(value)).toBe(
		createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	);
	expect(() => judgmentDigest([value])).toThrow("canonical value too deep");
	const cyclic: { self?: unknown } = {};
	cyclic.self = cyclic;
	expect(() => judgmentDigest(cyclic)).toThrow("canonical value too deep");
});

test("snapshot opaque refs and independently bounded revisions", () => {
	for (const field of ["frozenNeuralRef", "observationRef"] as const) {
		for (const ref of [null, "any-opaque-id"])
			expect(
				parseJudgmentSnapshotRef({ ...snapshot, [field]: ref })[field],
			).toBe(ref);
		for (const ref of [42, "", "x".repeat(161)])
			expect(() =>
				parseJudgmentSnapshotRef({ ...snapshot, [field]: ref }),
			).toThrow();
	}
	for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() =>
			parseJudgmentSnapshotRef({ ...snapshot, workingRevision: value }),
		).toThrow();
		expect(() =>
			parseJudgmentSnapshotRef({
				...snapshot,
				domainRevisions: { life: value },
			}),
		).toThrow();
	}
	expect(() =>
		parseJudgmentSnapshotRef({
			...snapshot,
			objectiveProfileRefs: { ...snapshot.objectiveProfileRefs, fourth: {} },
		}),
	).toThrow(/unknown/);
	expect(() =>
		parseJudgmentSnapshotRef({
			...snapshot,
			sourceRefs: [{ ...snapshot.sourceRefs[0], extra: 1 }],
		}),
	).toThrow(/unknown/);
});

test("snapshot source IDs use context owner bounds without widening agent or unknown-owner IDs", () => {
	for (const kind of ["request", "entry", "summary"]) {
		for (const length of [160, 161, 256]) {
			const source = { kind, id: "x".repeat(length), revision: 0 };
			expect(
				parseJudgmentSnapshotRef({ ...snapshot, sourceRefs: [source] })
					.sourceRefs,
			).toEqual([source]);
		}
		for (const id of ["x".repeat(257), "", " ", "x\u0000y", null, 42])
			expect(() =>
				parseJudgmentSnapshotRef({
					...snapshot,
					sourceRefs: [{ kind, id, revision: 0 }],
				}),
			).toThrow("invalid source id");
	}
	for (const kind of ["custom-owner", "Entry", " entry "]) {
		const source = { kind, id: "x".repeat(160), revision: 0 };
		expect(
			parseJudgmentSnapshotRef({ ...snapshot, sourceRefs: [source] })
				.sourceRefs,
		).toEqual([source]);
		expect(() =>
			parseJudgmentSnapshotRef({
				...snapshot,
				sourceRefs: [{ ...source, id: "x".repeat(161) }],
			}),
		).toThrow("invalid source id");
	}
	for (const agentId of ["x".repeat(161), "x".repeat(256)])
		expect(() => parseJudgmentSnapshotRef({ ...snapshot, agentId })).toThrow(
			"invalid agent id",
		);
});

test("3999054856 snapshot rejects conflicting revisions for one logical source", () => {
	expect(() =>
		parseJudgmentSnapshotRef({
			...snapshot,
			sourceRefs: [
				{ kind: "request", id: "same-source", revision: 1 },
				{ kind: "request", id: "same-source", revision: 2 },
			],
		}),
	).toThrow("duplicate source refs");
	expect(
		parseJudgmentSnapshotRef({
			...snapshot,
			sourceRefs: [
				{ kind: "request", id: "same-source", revision: 1 },
				{ kind: "entry", id: "same-source", revision: 2 },
				{ kind: "request", id: "other-source", revision: 2 },
			],
		}).sourceRefs,
	).toHaveLength(3);
});

test("snapshot requires a bounded policy identity without a fallback", () => {
	const { policyRevision: _revision, ...withoutRevision } = snapshot;
	expect(() => parseJudgmentSnapshotRef(withoutRevision)).toThrow();
	for (const policyId of [undefined, null, "", " ", 42, "x".repeat(161)])
		expect(() => parseJudgmentSnapshotRef({ ...snapshot, policyId })).toThrow();
	const withPolicy = { ...snapshot, policyId: "personal.v1" };
	const { policyId: _policyId, ...withoutPolicy } = withPolicy;
	expect(() => parseJudgmentSnapshotRef(withoutPolicy)).toThrow();
	expect(parseJudgmentSnapshotRef(withPolicy)).toEqual(withPolicy);
	expect(snapshotDigest({ ...withPolicy, policyId: "other-policy" })).not.toBe(
		snapshotDigest(withPolicy),
	);
});

test("selection bias is bounded even for excluded candidates and zero lambda", () => {
	for (const b of [-1 - Number.EPSILON, 1 + Number.EPSILON, -2, 2]) {
		for (const p0 of [0, 1]) {
			const candidates = [
				{ optionKey: "a", p0, b },
				{ optionKey: "b", p0: 1 - p0, b: null },
			];
			expect(() => parseSelectionSpec(signedSpec({ candidates }))).toThrow(
				"invalid bias",
			);
		}
	}
	for (const b of [null, -1, -0.5, 0, 0.5, 1]) {
		const valid = signedSpec({ candidates: [{ optionKey: "a", p0: 1, b }] });
		expect(parseSelectionSpec(valid)).toEqual(valid);
	}
});

test("bounded text, ids, lists, uniqueness and canonical list order", () => {
	for (const objective of ["", " ", "x\u0000y", "x".repeat(1001)])
		expect(() => parseObjectiveProfile({ ...profile, objective })).toThrow();
	expect(() =>
		parseObjectiveProfile({ ...profile, objectiveId: "x".repeat(161) }),
	).toThrow();
	expect(() => parseObjectiveProfile({ ...profile, revision: 0 })).toThrow();
	expect(() =>
		parseObjectiveProfile({ ...profile, comparisonCriteria: ["a", "a"] }),
	).toThrow();
	expect(() =>
		parseObjectiveProfile({
			...profile,
			comparisonCriteria: Array.from(
				{ length: 257 },
				(_, i) => `criterion-${i}`,
			),
		}),
	).toThrow();
	expect(
		parseObjectiveProfile({ ...profile, comparisonCriteria: ["b", "a"] })
			.comparisonCriteria,
	).toEqual(["a", "b"]);
	expect(
		parseObjectiveProfile({
			...profile,
			comparisonCriteria: Array.from(
				{ length: 256 },
				(_, i) => `criterion-${i}`,
			),
		}).comparisonCriteria,
	).toHaveLength(256);
});

test("assessment enforces module detail, input digest, JSON, and recommendation membership", () => {
	for (const moduleKind of MODULE_KINDS)
		expect(moduleAssessment(moduleKind).moduleKind).toBe(moduleKind);
	expect(() =>
		parseAssessment({ ...assessment, detail: { kind: "values", body: {} } }),
	).toThrow();
	expect(() =>
		parseAssessment({ ...assessment, inputDigest: "wrong" }),
	).toThrow();
	expect(() =>
		parseAssessment({ ...assessment, recommendedOptionKeys: ["missing"] }),
	).toThrow();
	expect(() =>
		parseAssessment({ ...assessment, objectiveAssessments: [option, option] }),
	).toThrow();
	expect(() =>
		parseAssessment({ ...assessment, proposedOptionKeys: ["a", "a"] }),
	).toThrow();
	for (const body of [
		[],
		{ bad: undefined },
		{ bad: Infinity },
		{ bad: () => 1 },
	])
		expect(() =>
			parseAssessment({ ...assessment, detail: { kind: "forecasts", body } }),
		).toThrow();
	expect(() =>
		parseAssessment({
			...assessment,
			detail: { ...assessment.detail, extra: true },
		}),
	).toThrow(/unknown/);
});

test("option stance requires exactly the corresponding severity or unavailable reason", () => {
	for (const severity of SEVERITIES)
		expect(
			parseOptionAssessment({ ...option, stance: "oppose", severity }).severity,
		).toBe(severity);
	expect(
		parseOptionAssessment({
			...option,
			stance: "unavailable",
			unavailableReason: "insufficient_evidence",
		}).stance,
	).toBe("unavailable");
	for (const change of [
		{ stance: "oppose", severity: null },
		{ stance: "unavailable", unavailableReason: null },
		{ stance: "accept", severity: "preference" },
		{ unavailableReason: "unexpected" },
		{ stance: "unavailable", unavailableReason: " " },
		{ stance: "neutral" },
	])
		expect(() => parseOptionAssessment({ ...option, ...change })).toThrow();
});

test("commitment opposition can identify the protected intentions explicitly", () => {
	const attributed = {
		...option,
		stance: "oppose",
		severity: "commitment_breach",
		breachedIntentionIds: ["intention-a", "intention-b"],
	};
	expect(JSON.stringify(parseOptionAssessment(attributed))).toBe(
		JSON.stringify(attributed),
	);
	for (const breachedIntentionIds of [
		[""],
		["a", "a"],
		["x".repeat(161)],
		"not-an-array",
	])
		expect(() =>
			parseOptionAssessment({ ...attributed, breachedIntentionIds }),
		).toThrow();
	expect(() =>
		parseOptionAssessment({
			...attributed,
			stance: "prefer",
			severity: null,
		}),
	).toThrow();
});

test("assessment sets require one of each module in declared order and matching snapshot", () => {
	const set = assessmentSet();
	expect(parseAssessmentSet(set).assessments.map((a) => a.moduleKind)).toEqual([
		...MODULE_KINDS,
	]);
	for (const assessments of [
		set.assessments.slice(0, 2),
		[assessment, assessment, moduleAssessment("atropos")],
		[...set.assessments].reverse(),
		set.assessments.map((a) => ({ ...a, snapshotId: "other" })),
	])
		expect(() => parseAssessmentSet({ ...set, assessments })).toThrow();
	expect(() =>
		parseAssessmentSet({ ...set, snapshotDigest: "other" }),
	).toThrow();
});

test("selection rejects invalid mass, lambda, bias, order, duplicates, and tampered digests", () => {
	for (const candidates of [
		[],
		[{ optionKey: "a", p0: 0, b: null }],
		[{ optionKey: "a", p0: 0.9, b: null }],
		[
			{ optionKey: "a", p0: -1, b: null },
			{ optionKey: "b", p0: 2, b: null },
		],
		[{ optionKey: "a", p0: Infinity, b: null }],
		[{ optionKey: "a", p0: 1, b: NaN }],
		[...spec.candidates].reverse(),
		[
			{ optionKey: "a", p0: 0.5, b: null },
			{ optionKey: "a", p0: 0.5, b: null },
		],
	])
		expect(() => parseSelectionSpec(signedSpec({ candidates }))).toThrow();
	for (const lambda of [-1, Infinity, NaN])
		expect(() => parseSelectionSpec(signedSpec({ lambda }))).toThrow();
	expect(() =>
		parseSelectionSpec({ ...spec, eligibleDigest: "wrong" }),
	).toThrow();
	expect(() => parseSelectionSpec({ ...spec, specDigest: "wrong" })).toThrow();
	const withExcluded = signedSpec({
		candidates: [
			{ optionKey: "a", p0: 1, b: -1 },
			{ optionKey: "b", p0: 0, b: null },
		],
	});
	expect(parseSelectionSpec(withExcluded)).toEqual(withExcluded);
	expect(withExcluded.eligibleDigest).toBe(judgmentDigest(["a"]));
	expect(
		parseSelectionSpec(
			signedSpec({ candidates: [{ optionKey: "a", p0: 1 - 5e-13, b: null }] }),
		).candidates,
	).toHaveLength(1);
});

test("resolution hold reason is present exactly when unresolved", () => {
	for (const status of ["held", "deferred"] as const) {
		expect(
			parseResolutionRecord({
				...resolution,
				status,
				holdReason: "no eligible candidate",
			}).status,
		).toBe(status);
		expect(() => parseResolutionRecord({ ...resolution, status })).toThrow();
	}
	expect(() =>
		parseResolutionRecord({ ...resolution, holdReason: "unexpected" }),
	).toThrow();
	expect(() =>
		parseResolutionRecord({ ...resolution, status: "open" }),
	).toThrow();
	expect(() =>
		parseResolutionRecord({ ...resolution, order: ["clotho", "clotho"] }),
	).toThrow();
	expect(() =>
		parseResolutionRecord({
			...resolution,
			ranking: [{ optionKey: "a", rank: 0 }],
		}),
	).toThrow();
});

test("intention acceptance requires user authority only for user commitments", () => {
	for (const kind of INTENTION_KINDS) {
		for (const acceptedBy of ACCEPTED_BY) {
			const record = {
				...intention,
				kind,
				acceptance: { ...intention.acceptance, acceptedBy },
			};
			if (kind === "user_commitment" && acceptedBy === "host_autonomy") {
				const adopted = { ...adopt(), kind, acceptance: record.acceptance };
				for (const candidate of [record, adopted])
					expect(() => parseIntentionRecord(candidate)).toThrow(
						"user commitment requires user acceptance",
					);
				expect(() => adopt(record)).toThrow(
					"user commitment requires user acceptance",
				);
			} else {
				expect(parseIntentionRecord(record)).toEqual(record);
				expect(parseIntentionRecord(adopt(record))).toEqual(adopt(record));
			}
		}
	}
});

for (const relation of ["conflicts", "supersedes", "depends"] as const) {
	test(`intention rejects self-${relation} while retaining an independent target`, () => {
		const independent = {
			...intention,
			relatedIntentions: [{ intentionId: "intention-2", relation }],
		};
		expect(parseIntentionRecord(independent)).toEqual(independent);
		expect(() =>
			parseIntentionRecord({
				...intention,
				relatedIntentions: [{ intentionId: intention.intentionId, relation }],
			}),
		).toThrow("self-referential intention relation");
	});
}

function adopt(record = intention): IntentionRecord {
	return transitionIntention(record, {
		to: "adopted",
		reason: "accepted",
		evidenceRef: null,
		at: transition.at,
	});
}
function activate(): IntentionRecord {
	return transitionIntention(adopt(), {
		to: "active",
		reason: "started",
		evidenceRef: null,
		at: transition.at,
	});
}

const laterAdoption = transitionIntention(intention, {
	to: "adopted",
	reason: "accepted",
	evidenceRef: null,
	at: "2026-09-12T00:00:00.000Z",
});
for (const { label, source, change } of [
	{
		label: "before acceptance",
		source: intention,
		change: {
			to: "adopted" as const,
			reason: "accepted",
			evidenceRef: null,
			at: "2026-09-10T00:00:00.000Z",
		},
	},
	{
		label: "before previous transition",
		source: laterAdoption,
		change: {
			to: "active" as const,
			reason: "started",
			evidenceRef: null,
			at: "2026-09-11T12:00:00.000Z",
		},
	},
]) {
	test(`3999091815 restored history rejects ${label}`, () => {
		expect(() =>
			parseIntentionRecord({
				...source,
				revision: source.revision + 1,
				status: change.to,
				history: [...source.history, { ...change, from: source.status }],
			}),
		).toThrow("nonchronological intention history");
	});
	test(`3999091815 pure transition rejects ${label}`, () => {
		expect(() => transitionIntention(source, change)).toThrow(
			"nonchronological intention history",
		);
	});
}
test.each(["2026-09-12T00:00:00.000Z", "2026-09-12T01:00:00.000Z"])(
	"3999091815 equal or increasing transition time remains valid: %s",
	(at) => {
		const result = transitionIntention(laterAdoption, {
			to: "active",
			reason: "started",
			evidenceRef: null,
			at,
		});
		expect(parseIntentionRecord(result)).toEqual(result);
		expect(result.history.at(-1)?.at).toBe(at);
	},
);

test("intention transitions complete the legal lifecycle without mutating input", () => {
	let record = intention;
	for (const to of [
		"adopted",
		"active",
		"suspended",
		"active",
		"completed",
	] as const) {
		const before = structuredClone(record);
		const evidenceRef =
			to === "completed"
				? "outcome-1"
				: to === "suspended" || record.status === "suspended"
					? intention.acceptance.sourceRef
					: null;
		const next = transitionIntention(record, {
			to,
			reason: "fixture transition",
			evidenceRef,
			at: transition.at,
		});
		expect(record).toEqual(before);
		expect(next).not.toBe(record);
		expect(next.history).not.toBe(record.history);
		expect(next.revision).toBe(record.revision + 1);
		expect(next.status).toBe(to);
		expect(next.history.at(-1)).toEqual({
			from: record.status,
			to,
			reason: "fixture transition",
			evidenceRef,
			at: transition.at,
		});
		expect(parseIntentionRecord(next)).toEqual(next);
		record = next;
	}
	for (const to of INTENTION_STATUSES)
		expect(() =>
			transitionIntention(record, {
				to,
				reason: "attempt",
				evidenceRef: "outcome-1",
				at: transition.at,
			}),
		).toThrow(`invalid intention transition: completed -> ${to}`);
});

const malformedTransitionSources: IntentionRecord[] = [
	{ ...intention, revision: -1 },
	{ ...intention, revision: 1 },
	{
		...intention,
		acceptance: { ...intention.acceptance, acceptedBy: "host_autonomy" },
	},
	{
		...intention,
		relatedIntentions: [
			{ intentionId: intention.intentionId, relation: "depends" as const },
		],
	},
];
test.each(malformedTransitionSources)(
	"3998986145 transitions reject malformed source records: %j",
	(record) => {
		const before = structuredClone(record);
		expect(() =>
			transitionIntention(record, {
				to: "adopted",
				reason: "accepted",
				evidenceRef: null,
				at: transition.at,
			}),
		).toThrow();
		expect(record).toEqual(before);
	},
);

test("caller-supplied from cannot skip intention states", () => {
	const forged = {
		...transition,
		from: "active",
		to: "completed" as const,
		evidenceRef: "outcome-1",
	};
	expect(() => transitionIntention(intention, forged)).toThrow(
		/intention transition/,
	);
	expect(intention.status).toBe("proposed");
	expect(intention.history).toEqual([]);
});

test("intention changes reject unknown fields", () => {
	const change = {
		to: "adopted" as const,
		reason: "accepted",
		evidenceRef: null,
		at: transition.at,
	};
	for (const extra of [{ unexpected: true }, { from: "proposed" }])
		expect(() =>
			transitionIntention(intention, { ...change, ...extra }),
		).toThrow(/intention transition/);
});

test("intention transition table is frozen at every level", () => {
	expect(Object.isFrozen(INTENTION_TRANSITIONS)).toBe(true);
	for (const edges of Object.values(INTENTION_TRANSITIONS))
		expect(Object.isFrozen(edges)).toBe(true);
});

test("assignment cannot enable a forbidden intention edge", () => {
	const original = INTENTION_TRANSITIONS.proposed;
	try {
		expect(Reflect.set(INTENTION_TRANSITIONS, "proposed", ["completed"])).toBe(
			false,
		);
		expect(Reflect.set(original, "0", "completed")).toBe(false);
		const change = {
			to: "completed" as const,
			reason: "done",
			evidenceRef: "outcome-1",
			at: transition.at,
		};
		expect(() => transitionIntention(intention, change)).toThrow(
			"invalid intention transition",
		);
		expect(() =>
			parseIntentionRecord({
				...intention,
				revision: 1,
				status: "completed",
				history: [{ ...change, from: "proposed" }],
			}),
		).toThrow("invalid intention transition");
		expect(parseIntentionRecord(adopt()).status).toBe("adopted");
	} finally {
		Reflect.set(INTENTION_TRANSITIONS, "proposed", original);
		Reflect.set(original, "0", "adopted");
	}
});

test("intention table and all prohibited edges are explicit", () => {
	expect(INTENTION_TRANSITIONS).toEqual({
		proposed: ["adopted", "cancelled"],
		adopted: ["active", "suspended", "cancelled"],
		active: ["suspended", "completed", "cancelled"],
		suspended: ["active", "cancelled"],
		completed: [],
		cancelled: [],
	});
	const active = activate();
	const suspended = transitionIntention(active, {
		to: "suspended",
		reason: "pause",
		evidenceRef: intention.acceptance.sourceRef,
		at: transition.at,
	});
	const completed = transitionIntention(active, {
		to: "completed",
		reason: "done",
		evidenceRef: "outcome-1",
		at: transition.at,
	});
	const cancelled = transitionIntention(intention, {
		to: "cancelled",
		reason: "withdrawn",
		evidenceRef: intention.acceptance.sourceRef,
		at: transition.at,
	});
	for (const record of [
		intention,
		adopt(),
		active,
		suspended,
		completed,
		cancelled,
	]) {
		for (const to of INTENTION_STATUSES) {
			const change = {
				to,
				reason: "fixture edge",
				evidenceRef:
					to === "completed" ? "outcome-1" : intention.acceptance.sourceRef,
				at: transition.at,
			};
			if (INTENTION_TRANSITIONS[record.status].includes(to)) {
				expect(
					parseIntentionRecord({
						...record,
						status: to,
						revision: record.revision + 1,
						history: [...record.history, { ...change, from: record.status }],
					}).status,
				).toBe(to);
				if (
					to === "cancelled" &&
					["adopted", "active", "suspended"].includes(record.status)
				)
					expect(() => transitionIntention(record, change)).toThrow(
						"user commitment cancellation authority is unavailable",
					);
				else
					expect(
						parseIntentionRecord(transitionIntention(record, change)).status,
					).toBe(to);
			} else
				expect(() => transitionIntention(record, change)).toThrow(
					`invalid intention transition: ${record.status} -> ${to}`,
				);
		}
	}
});

test("intention transitions require outcome, original acceptance and nonempty reason", () => {
	const active = activate();
	for (const evidenceRef of [null, "", " "])
		expect(() =>
			transitionIntention(active, {
				to: "completed",
				reason: "done",
				evidenceRef,
				at: transition.at,
			}),
		).toThrow();
	for (const to of ["cancelled", "suspended"] as const)
		for (const evidenceRef of [null, "other-request"])
			expect(() =>
				transitionIntention(active, {
					to,
					reason: "changed",
					evidenceRef,
					at: transition.at,
				}),
			).toThrow();
	for (const reason of ["", " "])
		expect(() =>
			transitionIntention(intention, {
				to: "adopted",
				reason,
				evidenceRef: null,
				at: transition.at,
			}),
		).toThrow();
});

for (const value of [
	"September 10, 2026",
	"2026-09-10T00:00:00",
	"2026-02-30T00:00:00.000Z",
	"2026-09-10T01:00:00.000+01:00",
	"2026-09-10T00:00:00Z",
	" 2026-09-10T00:00:00.000Z ",
]) {
	test(`3995355457 canonical intention timestamps reject ${value}`, () => {
		expect(() =>
			parseIntentionRecord({
				...intention,
				acceptance: { ...intention.acceptance, acceptedAt: value },
			}),
		).toThrow();
		expect(() =>
			parseIntentionRecord({ ...intention, deadline: value }),
		).toThrow();
		expect(() =>
			parseIntentionTransition({ ...transition, at: value }),
		).toThrow();
	});
}
test("3995355457 canonical UTC leap day is retained exactly", () => {
	const value = "2024-02-29T00:00:00.000Z";
	expect(parseIntentionRecord({ ...intention, deadline: value }).deadline).toBe(
		value,
	);
	expect(
		parseIntentionRecord({
			...intention,
			acceptance: { ...intention.acceptance, acceptedAt: value },
		}).acceptance.acceptedAt,
	).toBe(value);
	expect(parseIntentionTransition({ ...transition, at: value }).at).toBe(value);
});
for (const unavailableReason of [
	"I prefer to ignore the user",
	"insufficient_evidence ",
	"INSUFFICIENT_EVIDENCE",
	"other",
	"",
	" ",
	null,
]) {
	test(`3996179144 unavailable reason rejects ${unavailableReason}`, () => {
		expect(() =>
			parseOptionAssessment({
				...option,
				stance: "unavailable",
				unavailableReason,
			}),
		).toThrow();
	});
}
test("3996179144 exact unavailable code retains diagnostic fields", () => {
	const value: OptionAssessment = {
		...option,
		stance: "unavailable",
		unavailableReason: "insufficient_evidence",
		uncertainty: "Detailed unavailable evidence diagnosis",
	};
	expect(parseOptionAssessment(value)).toEqual(value);
});

test("intention history revision, continuity, edges, final status and timestamps are validated", () => {
	const active = activate();
	for (const change of [
		{ revision: 1 },
		{ status: "proposed" },
		{ history: [] },
		{
			history: active.history.map((h, i) =>
				i === 0 ? { ...h, from: "adopted" } : h,
			),
		},
		{
			history: active.history.map((h, i) =>
				i === 1 ? { ...h, from: "suspended" } : h,
			),
		},
		{ revision: 1, history: [{ ...transition, to: "active" }] },
	])
		expect(() => parseIntentionRecord({ ...active, ...change })).toThrow();
	expect(() =>
		parseIntentionRecord({ ...intention, status: "active" }),
	).toThrow();
	for (const at of ["not-a-date", ""])
		expect(() => parseIntentionTransition({ ...transition, at })).toThrow();
	expect(() =>
		parseIntentionRecord({ ...intention, deadline: "not-a-date" }),
	).toThrow();
	expect(() =>
		parseIntentionRecord({
			...intention,
			acceptance: { ...intention.acceptance, acceptedAt: "not-a-date" },
		}),
	).toThrow();
	expect(() =>
		parseIntentionRecord({
			...intention,
			acceptance: { ...intention.acceptance, extra: true },
		}),
	).toThrow(/unknown/);
	expect(() =>
		parseIntentionRecord({
			...active,
			history: active.history.map((h) => ({ ...h, schemaVersion: 1 })),
		}),
	).toThrow(/unknown .* field schemaVersion/);
});
