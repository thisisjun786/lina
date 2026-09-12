import { expect, test } from "bun:test";
import {
	assessmentInputDigest,
	buildCanonicalOption,
	judgmentDigest,
	MODULE_KINDS,
	PERSONAL_POLICY_V1,
	parseAssessmentSet,
	rankMass,
	resolvePersonalRound,
	sampleSelection,
	snapshotDigest,
} from "../src/agents/index.ts";

test("rank mass remains normalized when absolute geometric weights overflow or underflow", () => {
	expect(rankMass([1076], 0.5)).toEqual([1]);
	expect(rankMass([1076, 1077], 0.5)).toEqual([2 / 3, 1 / 3]);
	expect(rankMass([1076, 1077], 2)).toEqual([1 / 3, 2 / 3]);
	expect(rankMass([2, 2], Number.MAX_VALUE)).toEqual([0.5, 0.5]);
});

function fixture(): Parameters<typeof resolvePersonalRound>[0] {
	const option = buildCanonicalOption({
		kind: "noop",
		actor: { agentId: "agent", scopeId: "scope" },
		targetId: null,
		args: {},
		preconditions: { kind: "noop", reason: "nothing needed" },
	});
	const ref = (objectiveId: string) => ({
		objectiveId,
		revision: 2,
		digest: judgmentDigest({ objectiveId, revision: 2 }),
	});
	const snapshot = {
		schemaVersion: 1 as const,
		roundId: "review-round",
		...option.actor,
		sourceRefs: [],
		workingRevision: 0,
		instructionRevision: 0,
		policyId: PERSONAL_POLICY_V1.policyId,
		policyRevision: PERSONAL_POLICY_V1.revision,
		identityRevision: 0,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs: {
			clotho: ref("clotho-objective"),
			lachesis: ref("lachesis-objective"),
			atropos: ref("atropos-objective"),
		},
		observationRef: null,
		frozenNeuralRef: null,
		situation: "autonomous" as const,
		clockId: "clock",
		sequence: 0,
		bindingGeneration: 0,
	};
	const digest = snapshotDigest(snapshot);
	return {
		policy: PERSONAL_POLICY_V1,
		snapshot,
		options: [option],
		set: parseAssessmentSet({
			schemaVersion: 1,
			roundId: snapshot.roundId,
			snapshotDigest: digest,
			assessments: MODULE_KINDS.map((moduleKind) => {
				const objectiveRef = snapshot.objectiveProfileRefs[moduleKind];
				return {
					schemaVersion: 1,
					moduleKind,
					snapshotId: snapshot.roundId,
					snapshotDigest: digest,
					objectiveRef,
					mechanismRevision: 1,
					inputDigest: assessmentInputDigest({
						snapshotDigest: digest,
						objectiveRef,
						mechanismRevision: 1,
					}),
					completeText: "assessment",
					evidenceRefs: [],
					proposedOptionKeys: [option.optionKey],
					objectiveAssessments: [
						{
							optionKey: option.optionKey,
							stance: "prefer",
							severity: null,
							unavailableReason: null,
							gain: "gain",
							loss: "loss",
							uncertainty: "uncertainty",
							evidenceRefs: [],
						},
					],
					recommendedOptionKeys: [option.optionKey],
					detail: {
						kind: {
							clotho: "forecasts",
							lachesis: "values",
							atropos: "continuity",
						}[moduleKind],
						body: {},
					},
					diagnostics: {},
				};
			}),
		}),
		eligibility: [
			{ optionKey: option.optionKey, eligible: true, reason: null },
		],
		bias: {},
	};
}

for (const field of ["agentId", "scopeId"] as const) {
	test(`rejects candidate ${field} outside its frozen round`, () => {
		const input = fixture();
		const original = input.options[0];
		if (!original) throw Error("missing candidate");
		const foreign = buildCanonicalOption({
			...original,
			actor: { ...original.actor, [field]: "foreign" },
		});
		input.options = [foreign];
		input.eligibility = [
			{ optionKey: foreign.optionKey, eligible: true, reason: null },
		];
		for (const assessment of input.set.assessments) {
			assessment.proposedOptionKeys = [foreign.optionKey];
			assessment.recommendedOptionKeys = [foreign.optionKey];
			for (const opinion of assessment.objectiveAssessments)
				opinion.optionKey = foreign.optionKey;
		}
		expect(parseAssessmentSet(input.set)).toEqual(input.set);
		expect(() => resolvePersonalRound(input)).toThrow(
			"option actor snapshot mismatch",
		);
	});
}

for (const removal of ["host", "commitment", "infeasible", "ranked"] as const) {
	test(`concessions distinguish ${removal} exclusion from a ranked preference loss`, () => {
		const input = fixture();
		const preferred = input.options[0];
		if (!preferred) throw Error("missing candidate");
		const alternative = buildCanonicalOption({
			...preferred,
			targetId: "alternative",
		});
		input.options.push(alternative);
		input.eligibility = [
			{
				optionKey: preferred.optionKey,
				eligible: removal !== "host",
				reason: removal === "host" ? "not authorized" : null,
			},
			{ optionKey: alternative.optionKey, eligible: true, reason: null },
		];
		for (const assessment of input.set.assessments) {
			const opinion = assessment.objectiveAssessments[0];
			if (!opinion) throw Error("missing opinion");
			assessment.objectiveAssessments.push({
				...opinion,
				optionKey: alternative.optionKey,
				stance:
					removal === "ranked" && assessment.moduleKind === "lachesis"
						? "prefer"
						: "accept",
			});
			if (removal === "ranked" && assessment.moduleKind === "lachesis")
				opinion.stance = "accept";
			if (removal === "commitment" && assessment.moduleKind === "atropos") {
				opinion.stance = "oppose";
				opinion.severity = "commitment_breach";
			}
			if (removal === "infeasible" && assessment.moduleKind === "clotho") {
				opinion.stance = "oppose";
				opinion.severity = "infeasible";
			}
		}
		const { resolution } = resolvePersonalRound(input);
		expect(resolution.status).toBe("resolved");
		if (removal === "ranked") {
			expect(resolution.conceded).toContainEqual({
				moduleKind: "clotho",
				optionKey: preferred.optionKey,
			});
			expect(resolution.ranking).toContainEqual({
				optionKey: preferred.optionKey,
				rank: 2,
			});
		} else {
			expect(resolution.excluded.map((row) => row.optionKey)).toContain(
				preferred.optionKey,
			);
			expect(resolution.conceded).toEqual([]);
		}
	});
}

test("personal.v1 revision one rejects altered or malformed declarations", () => {
	const input = fixture();
	for (const change of [
		{ ratio: 0.9 },
		{ ratio: 0 },
		{ orders: { ...PERSONAL_POLICY_V1.orders, autonomous: [] } },
		{
			orders: {
				...PERSONAL_POLICY_V1.orders,
				user_request: PERSONAL_POLICY_V1.orders.autonomous,
			},
		},
		{ lambda: { ...PERSONAL_POLICY_V1.lambda, user_request: 1 } },
		{ lambda: { ...PERSONAL_POLICY_V1.lambda, autonomous: 0 } },
		{ stanceOrder: [] },
		{ stanceOrder: [...PERSONAL_POLICY_V1.stanceOrder].reverse() },
	]) {
		expect(() =>
			resolvePersonalRound({
				...input,
				policy: { ...PERSONAL_POLICY_V1, ...change },
			}),
		).toThrow("unsupported personal policy declaration");
	}
	expect(
		resolvePersonalRound({
			...input,
			policy: structuredClone(PERSONAL_POLICY_V1),
		}),
	).toEqual(resolvePersonalRound(input));
});

test("a module omitted from round ordering makes no concession", () => {
	const input = fixture();
	const original = input.options[0];
	if (!original) throw Error("missing candidate");
	const alternative = buildCanonicalOption({
		...original,
		targetId: "alternative",
	});
	input.options.push(alternative);
	input.eligibility.push({
		optionKey: alternative.optionKey,
		eligible: true,
		reason: null,
	});
	for (const assessment of input.set.assessments) {
		const opinion = assessment.objectiveAssessments[0];
		if (!opinion) throw Error("missing opinion");
		opinion.stance = assessment.moduleKind === "clotho" ? "prefer" : "accept";
		assessment.objectiveAssessments.push({
			...opinion,
			optionKey: alternative.optionKey,
			stance: assessment.moduleKind === "clotho" ? "unavailable" : "prefer",
			unavailableReason:
				assessment.moduleKind === "clotho" ? "missing forecast" : null,
		});
	}
	const result = resolvePersonalRound(input);
	expect(result.resolution.ranking).toContainEqual({
		optionKey: original.optionKey,
		rank: 2,
	});
	expect(result.resolution.abstentions).toContainEqual({
		moduleKind: "clotho",
		optionKey: alternative.optionKey,
		reason: "missing forecast",
	});
	expect(result.resolution.conceded).toEqual([]);
});

test("partial neural lookup failure keeps the entire decision at its baseline distribution", () => {
	const input = fixture();
	const original = input.options[0];
	if (!original) throw Error("missing candidate");
	const alternative = buildCanonicalOption({
		...original,
		targetId: "alternative",
	});
	input.options.push(alternative);
	input.eligibility.push({
		optionKey: alternative.optionKey,
		eligible: true,
		reason: null,
	});
	for (const assessment of input.set.assessments) {
		const opinion = assessment.objectiveAssessments[0];
		if (!opinion) throw Error("missing opinion");
		assessment.objectiveAssessments.push({
			...opinion,
			optionKey: alternative.optionKey,
			stance: "accept",
		});
	}
	input.bias = { [original.optionKey]: null, [alternative.optionKey]: 1 };
	const { spec } = resolvePersonalRound(input);
	if (!spec) throw Error("missing selection spec");
	const restored = JSON.parse(JSON.stringify(spec));
	const sampled = sampleSelection(restored, 0.5);
	expect(
		sampled.probabilities.find((row) => row.optionKey === original.optionKey)
			?.p,
	).toBeCloseTo(2 / 3, 12);
	expect(
		sampled.probabilities.find((row) => row.optionKey === alternative.optionKey)
			?.p,
	).toBeCloseTo(1 / 3, 12);

	const excluded = buildCanonicalOption({
		...original,
		targetId: "excluded",
	});
	input.options.push(excluded);
	input.bias = { [original.optionKey]: 0, [alternative.optionKey]: 1 };
	const complete = resolvePersonalRound(input).spec;
	if (!complete) throw Error("missing complete spec");
	const modulated = sampleSelection(complete, 0.5);
	expect(
		modulated.probabilities.find((row) => row.optionKey === original.optionKey)
			?.p,
	).toBeCloseTo(2 / (2 + Math.E), 12);
	expect(
		modulated.probabilities.find((row) => row.optionKey === excluded.optionKey)
			?.p,
	).toBe(0);
});

for (const outcome of ["resolved", "held", "deferred"] as const) {
	function round() {
		const input = fixture();
		if (outcome === "deferred") input.eligibility = [];
		if (outcome === "held") {
			for (const assessment of input.set.assessments) {
				assessment.objectiveAssessments = [];
				assessment.recommendedOptionKeys = [];
			}
		}
		return input;
	}

	test(`valid frozen round remains ${outcome}`, () => {
		const input = round();
		const before = structuredClone(input);
		const result = resolvePersonalRound(input);
		expect(result.resolution.status).toBe(outcome);
		expect(input).toEqual(before);
		if (outcome === "resolved") {
			if (!result.spec) throw Error("missing selection spec");
			const expected = input.options[0];
			if (!expected) throw Error("missing fixture candidate");
			expect(result.spec.snapshotDigest).toBe(snapshotDigest(input.snapshot));
			expect(sampleSelection(result.spec, NaN).optionKey).toBe(
				expected.optionKey,
			);
		} else expect(result.spec).toBeNull();
	});

	for (const change of [{ policyId: "foreign-policy" }, { revision: 2 }]) {
		test(`rejects mismatched policy ${Object.keys(change)[0]} before ${outcome}`, () => {
			const input = round();
			input.policy = { ...input.policy, ...change };
			expect(() => resolvePersonalRound(input)).toThrow(
				"policy snapshot mismatch",
			);
		});
	}

	for (const moduleKind of MODULE_KINDS) {
		for (const change of [
			{ objectiveId: "stale-objective" },
			{ revision: 1 },
			{ digest: judgmentDigest("stale-objective") },
		]) {
			test(`rejects ${moduleKind} stale ${Object.keys(change)[0]} with recomputed input digest before ${outcome}`, () => {
				const input = round();
				const assessment = input.set.assessments.find(
					(a) => a.moduleKind === moduleKind,
				);
				if (!assessment) throw Error("missing assessment");
				assessment.objectiveRef = { ...assessment.objectiveRef, ...change };
				assessment.inputDigest = assessmentInputDigest(assessment);
				expect(parseAssessmentSet(input.set)).toEqual(input.set);
				expect(() => resolvePersonalRound(input)).toThrow(
					"assessment objective mismatch",
				);
			});
		}

		for (const field of [
			"proposedOptionKeys",
			"objectiveAssessments",
			"recommendedOptionKeys",
		] as const) {
			test(`rejects ${moduleKind} foreign ${field} before ${outcome}`, () => {
				const input = round();
				const assessment = input.set.assessments.find(
					(a) => a.moduleKind === moduleKind,
				);
				if (!assessment) throw Error("missing assessment");
				const foreign = buildCanonicalOption({
					kind: "noop",
					actor: { agentId: "agent", scopeId: "scope" },
					targetId: "foreign",
					args: {},
					preconditions: { kind: "noop", reason: "foreign candidate" },
				});
				if (field !== "proposedOptionKeys") {
					assessment.objectiveAssessments.push({
						optionKey: foreign.optionKey,
						stance: "prefer",
						severity: null,
						unavailableReason: null,
						gain: "gain",
						loss: "loss",
						uncertainty: "uncertainty",
						evidenceRefs: [],
					});
				}
				if (field !== "objectiveAssessments")
					assessment[field].push(foreign.optionKey);
				input.set = parseAssessmentSet(input.set);
				expect(() => resolvePersonalRound(input)).toThrow(
					"unknown assessment option key",
				);
			});
		}
	}
}
