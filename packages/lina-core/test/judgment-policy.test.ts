import { expect, test } from "bun:test";
import {
	type ArbitrationPolicy,
	assessmentInputDigest,
	buildCanonicalOption,
	type CanonicalOption,
	canonicalOptionKey,
	EFFECT_OWNERS,
	type JudgmentSnapshotRef,
	judgmentDigest,
	MODULE_KINDS,
	type ModuleKind,
	normalizeOptionArgs,
	type OptionAssessment,
	PERSONAL_CATALOG_ID,
	PERSONAL_OPTION_KINDS,
	PERSONAL_POLICY_V1,
	type PersonalOptionKind,
	type PersonalPrecondition,
	parseAssessmentSet,
	parseCanonicalOption,
	parseResolutionRecord,
	parseSelectionSpec,
	rankMass,
	resolvePersonalRound,
	type SelectionSpec,
	SITUATIONS,
	type Situation,
	type Stance,
	sampleSelection,
	snapshotDigest,
} from "../src/agents/index.ts";

const actor = { agentId: "agent", scopeId: "scope" };
const preconditions: PersonalPrecondition[] = [
	{
		kind: "intention.adopt",
		intentionKind: "user_commitment",
		sourceRef: "request",
	},
	{ kind: "intention.activate", intentionId: "intention" },
	{
		kind: "intention.suspend",
		intentionId: "intention",
		acceptanceSourceRef: "request",
		reason: "pause",
	},
	{
		kind: "intention.resume",
		intentionId: "intention",
		acceptanceSourceRef: "request",
		reason: "resume",
	},
	{
		kind: "intention.cancel",
		intentionId: "intention",
		acceptanceSourceRef: "request",
		authorityRef: "authority",
		userConfirmationRef: null,
	},
	{
		kind: "intention.complete",
		intentionId: "intention",
		outcomeRef: "outcome",
	},
	{
		kind: "task.start",
		authorityRef: "authority",
		taskText: "fixture task",
		intentionId: "intention",
	},
	{ kind: "task.send", taskId: "task", ownerId: "owner", revision: 0 },
	{ kind: "task.interrupt", taskId: "task", ownerId: "owner", revision: 1 },
	{ kind: "task.handover", taskId: "task", ownerId: "owner", revision: 1 },
	{ kind: "inquire", authorityRef: "authority" },
	{ kind: "defer", resumeCondition: "new input" },
	{ kind: "noop", reason: "nothing needed" },
];
function option(
	targetId: string,
	kind: PersonalOptionKind = "noop",
): CanonicalOption {
	const precondition = preconditions.find((p) => p.kind === kind);
	if (!precondition) throw Error("missing fixture precondition");
	return buildCanonicalOption({
		kind,
		actor,
		targetId,
		args: {},
		preconditions: precondition,
	});
}
function snapshot(situation: Situation): JudgmentSnapshotRef {
	const ref = (moduleKind: ModuleKind) => ({
		objectiveId: `objective-${moduleKind}`,
		revision: 1,
		digest: judgmentDigest({ moduleKind, objective: "fixture objective" }),
	});
	return {
		schemaVersion: 1,
		roundId: "round",
		...actor,
		sourceRefs: [],
		workingRevision: 0,
		instructionRevision: 0,
		policyRevision: 1,
		identityRevision: 0,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs: {
			clotho: ref("clotho"),
			lachesis: ref("lachesis"),
			atropos: ref("atropos"),
		},
		observationRef: null,
		frozenNeuralRef: null,
		situation,
		clockId: "clock",
		sequence: 0,
		bindingGeneration: 0,
	};
}
function opinion(
	stance: Stance,
	severity: OptionAssessment["severity"] = null,
): Partial<OptionAssessment> {
	return {
		stance,
		severity: stance === "oppose" ? (severity ?? "preference") : null,
		unavailableReason: stance === "unavailable" ? "missing observation" : null,
	};
}
function fixture(
	situation: Situation = "user_request",
	options = [option("a"), option("b"), option("c")],
	assess: (
		moduleKind: ModuleKind,
		option: CanonicalOption,
	) => Partial<OptionAssessment> | null = () => opinion("accept"),
): Parameters<typeof resolvePersonalRound>[0] {
	const snap = snapshot(situation);
	const digest = snapshotDigest(snap);
	const set = parseAssessmentSet({
		schemaVersion: 1,
		roundId: snap.roundId,
		snapshotDigest: digest,
		assessments: MODULE_KINDS.map((moduleKind) => {
			const objectiveRef = snap.objectiveProfileRefs[moduleKind];
			const objectiveAssessments = options.flatMap((o) => {
				const change = assess(moduleKind, o);
				return change === null
					? []
					: [
							{
								optionKey: o.optionKey,
								stance: "accept",
								severity: null,
								unavailableReason: null,
								gain: "gain",
								loss: "loss",
								uncertainty: "uncertainty",
								evidenceRefs: [],
								...change,
							},
						];
			});
			return {
				schemaVersion: 1,
				moduleKind,
				snapshotId: snap.roundId,
				snapshotDigest: digest,
				inputDigest: assessmentInputDigest({
					snapshotDigest: digest,
					objectiveRef,
					mechanismRevision: 1,
				}),
				objectiveRef,
				mechanismRevision: 1,
				completeText: "fixture assessment",
				evidenceRefs: [],
				proposedOptionKeys: [],
				objectiveAssessments,
				recommendedOptionKeys: objectiveAssessments
					.filter((o) => o.stance === "prefer")
					.map((o) => o.optionKey),
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
	});
	return {
		policy: PERSONAL_POLICY_V1,
		snapshot: snap,
		options,
		set,
		eligibility: options.map((o) => ({
			optionKey: o.optionKey,
			eligible: true,
			reason: null,
		})),
		bias: {},
	};
}
function resolve(input: Parameters<typeof resolvePersonalRound>[0]) {
	const before = structuredClone(input);
	const result = resolvePersonalRound(input);
	expect(input).toEqual(before);
	expect(parseResolutionRecord(result.resolution)).toEqual(result.resolution);
	if (result.spec) {
		expect(parseSelectionSpec(result.spec)).toEqual(result.spec);
		expect(
			Math.abs(result.spec.candidates.reduce((sum, c) => sum + c.p0, 0) - 1),
		).toBeLessThanOrEqual(1e-12);
		expect(result.spec.resolutionDigest).toBe(
			judgmentDigest(result.resolution),
		);
		expect(result.spec.assessmentSetDigest).toBe(judgmentDigest(input.set));
		expect(result.spec.snapshotDigest).toBe(snapshotDigest(input.snapshot));
		expect(result.spec.objectiveProfileRefs).toEqual(
			input.snapshot.objectiveProfileRefs,
		);
	}
	return result;
}
function requireSpec(
	result: ReturnType<typeof resolvePersonalRound>,
): SelectionSpec {
	if (!result.spec) throw Error("expected resolved fixture");
	return result.spec;
}
function samplingSpec(
	candidates: SelectionSpec["candidates"],
	lambda = 1,
): SelectionSpec {
	const base = requireSpec(resolve(fixture()));
	const result = {
		...base,
		candidates,
		lambda,
		eligibleDigest: judgmentDigest(
			candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
		),
	};
	return parseSelectionSpec({
		...result,
		specDigest: judgmentDigest({ ...result, specDigest: undefined }),
	});
}

test("catalog vocabulary, all per-kind fields and effect ownership", () => {
	expect(PERSONAL_CATALOG_ID).toBe("personal.v1");
	expect([...PERSONAL_OPTION_KINDS]).toEqual(preconditions.map((p) => p.kind));
	expect(EFFECT_OWNERS).toEqual([
		"judgment_store",
		"task_manager",
		"host",
		"none",
	]);
	for (const p of preconditions) {
		const o = option("target", p.kind);
		expect(o.effect).toEqual({
			owner: p.kind.startsWith("intention.")
				? "judgment_store"
				: p.kind.startsWith("task.")
					? "task_manager"
					: p.kind === "inquire"
						? "host"
						: "none",
			scope: actor.scopeId,
		});
		expect(parseCanonicalOption(o)).toEqual(o);
		for (const key of Object.keys(p)) {
			const missing = Object.fromEntries(
				Object.entries(p).filter(([field]) => field !== key),
			);
			expect(() =>
				parseCanonicalOption({ ...o, preconditions: missing }),
			).toThrow();
		}
	}
});

test("(1) canonical keys normalize case, target, sorted args, NFC, whitespace and empty values", () => {
	const base = option("task", "task.start");
	const a = {
		...base,
		kind: "Task.Start" as PersonalOptionKind,
		targetId: " task ",
		args: { b: "x", a: " y  z ", empty: " \t " },
	};
	const b = { ...base, args: { a: "y z", b: "x" } };
	expect(canonicalOptionKey(a)).toBe(canonicalOptionKey(b));
	expect(canonicalOptionKey({ ...b, targetId: "other" })).not.toBe(
		canonicalOptionKey(b),
	);
	expect(canonicalOptionKey({ ...b, args: { a: "e\u0301" } })).toBe(
		canonicalOptionKey({ ...b, args: { a: "\u00e9" } }),
	);
	expect(normalizeOptionArgs(a.args)).toEqual({ a: "y z", b: "x" });
	expect(Object.keys(normalizeOptionArgs(a.args))).toEqual(["a", "b"]);
	const built = buildCanonicalOption(a);
	expect(built.kind).toBe("task.start");
	expect(built.targetId).toBe("task");
	expect(built.args).toEqual(b.args);
	expect(built.optionKey).toBe(canonicalOptionKey(b));
	expect(canonicalOptionKey({ ...base, targetId: null })).toContain(":-:");
});

test("(2) golden option parses byte-identically and rejects invalid boundary data", () => {
	const golden = {
		schemaVersion: 1,
		catalogId: "personal.v1",
		kind: "noop",
		actor,
		targetId: null,
		args: {},
		preconditions: { kind: "noop", reason: "nothing needed" },
		effect: { owner: "none", scope: "scope" },
		optionKey:
			"personal.v1:noop:-:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
	};
	expect(JSON.stringify(parseCanonicalOption(golden))).toBe(
		JSON.stringify(golden),
	);
	for (const schemaVersion of [0, 2])
		expect(() =>
			parseCanonicalOption({ ...golden, schemaVersion, extra: true }),
		).toThrow(/Unsupported .* schema version/);
	expect(() =>
		parseCanonicalOption({ ...golden, kind: "memory.store" }),
	).toThrow("unknown personal.v1 option kind");
	for (const change of [
		{ catalogId: "other" },
		{ effect: { owner: "task_manager", scope: "scope" } },
		{ optionKey: "tampered" },
		{ preconditions: { kind: "defer", resumeCondition: "input" } },
		{ extra: true },
		{ actor: { ...actor, extra: true } },
		{ effect: { ...golden.effect, extra: true } },
		{ preconditions: { ...golden.preconditions, extra: true } },
		{ actor: { ...actor, agentId: "x".repeat(161) } },
		{ targetId: " " },
		{ args: { key: 1 } },
		{ args: { key: "x".repeat(1001) } },
		{ args: { key: "x\u0000y" } },
		{ preconditions: { kind: "noop", reason: " " } },
	])
		expect(() => parseCanonicalOption({ ...golden, ...change })).toThrow();
	for (const value of [null, [], "option"])
		expect(() => parseCanonicalOption(value)).toThrow();
	for (const revision of [-1, 0.5, Infinity])
		expect(() =>
			parseCanonicalOption({
				...option("task", "task.send"),
				preconditions: {
					kind: "task.send",
					taskId: "task",
					ownerId: "owner",
					revision,
				},
			}),
		).toThrow();
});

const orders: Record<Situation, [ModuleKind, ModuleKind, ModuleKind]> = {
	user_request: ["atropos", "clotho", "lachesis"],
	autonomous: ["lachesis", "clotho", "atropos"],
	transition: ["clotho", "atropos", "lachesis"],
};
for (const situation of SITUATIONS) {
	test(`(3,6,8) ${situation} uses declared order, lambda and reproducible digests`, () => {
		const options = MODULE_KINDS.map((m) => option(m));
		const input = fixture(situation, options, (m, o) =>
			opinion(m === o.targetId ? "prefer" : "accept"),
		);
		const result = resolve(input);
		expect(result.resolution.order).toEqual(orders[situation]);
		expect(result.resolution.ranking).toEqual(
			orders[situation].map((m, i) => ({
				optionKey: option(m).optionKey,
				rank: i + 1,
			})),
		);
		expect(result.resolution.policyRevision).toBe(1);
		expect(result.resolution.conflicts).toHaveLength(3);
		for (const m of MODULE_KINDS)
			expect(result.resolution.recommendations[m]).toEqual([
				option(m).optionKey,
			]);
		expect(result.resolution.conceded).toHaveLength(2);
		expect(result.resolution.conceded).not.toContainEqual({
			moduleKind: orders[situation][0],
			optionKey: option(orders[situation][0]).optionKey,
		});
		const spec = requireSpec(result);
		expect(spec.lambda).toBe(situation === "user_request" ? 0 : 1);
		expect(spec.candidates.every((c) => c.b === null)).toBe(true);
		expect(resolve(structuredClone(input)).spec?.specDigest).toBe(
			spec.specDigest,
		);
		const biased = resolve({
			...input,
			bias: Object.fromEntries(options.map((o) => [o.optionKey, 100])),
		});
		expect(biased.spec?.candidates.map((c) => c.p0)).toEqual(
			spec.candidates.map((c) => c.p0),
		);
		expect(biased.spec?.candidates.every((c) => c.b === 100)).toBe(true);
	});
}

test("(4) ties share dense rank and split rank mass, rather than doubling activity mass", () => {
	expect(rankMass([1, 2, 3], 0.5)).toEqual([4 / 7, 2 / 7, 1 / 7]);
	expect(rankMass([1, 1, 2], 0.5)).toEqual([1 / 3, 1 / 3, 1 / 3]);
	expect(rankMass([2, 1, 1], 0.5)).toEqual([1 / 3, 1 / 3, 1 / 3]);
	expect(rankMass([], 0.5)).toEqual([]);
	const result = resolve(
		fixture("user_request", undefined, (_, o) =>
			opinion(o.targetId === "c" ? "accept" : "prefer"),
		),
	);
	expect(result.resolution.ranking).toEqual([
		{ optionKey: option("a").optionKey, rank: 1 },
		{ optionKey: option("b").optionKey, rank: 1 },
		{ optionKey: option("c").optionKey, rank: 2 },
	]);
	expect(requireSpec(result).candidates.map((c) => c.p0)).toEqual([
		1 / 3,
		1 / 3,
		1 / 3,
	]);
});

test("(5) only original-acceptance suspend/cancel escape commitment protection", () => {
	const options = [
		"task.start",
		"intention.cancel",
		"intention.suspend",
		"intention.resume",
	].map((kind) => option(kind, kind as PersonalOptionKind));
	const result = resolve(
		fixture("user_request", options, (m) =>
			m === "atropos"
				? opinion("oppose", "commitment_breach")
				: opinion("accept"),
		),
	);
	for (const o of options) {
		const exempt =
			o.kind === "intention.cancel" || o.kind === "intention.suspend";
		expect(
			requireSpec(result).candidates.find((c) => c.optionKey === o.optionKey)
				?.p0,
		).toBe(exempt ? 0.5 : 0);
		if (!exempt)
			expect(result.resolution.excluded).toContainEqual({
				optionKey: o.optionKey,
				stage: "commitment_protection",
				byModule: "atropos",
				reason: expect.any(String),
			});
	}
	const cancel = option("cancel", "intention.cancel");
	const input = fixture("user_request", [cancel]);
	input.options = [
		{
			...cancel,
			preconditions: {
				kind: "intention.cancel",
				intentionId: "intention",
				authorityRef: "authority",
				acceptanceSourceRef: "",
				userConfirmationRef: null,
			},
		},
	];
	expect(() => resolvePersonalRound(input)).toThrow();
});

test("(5) preference never excludes, and only clotho drives infeasible exclusion", () => {
	for (const moduleKind of MODULE_KINDS) {
		for (const severity of ["preference", "infeasible"] as const) {
			const result = resolve(
				fixture("autonomous", undefined, (m, o) =>
					m === moduleKind && o.targetId === "a"
						? opinion("oppose", severity)
						: opinion("accept"),
				),
			);
			const p0 = requireSpec(result).candidates.find(
				(c) => c.optionKey === option("a").optionKey,
			)?.p0;
			if (moduleKind === "clotho" && severity === "infeasible") {
				expect(p0).toBe(0);
				expect(result.resolution.excluded).toContainEqual({
					optionKey: option("a").optionKey,
					stage: "infeasible",
					byModule: "clotho",
					reason: expect.any(String),
				});
			} else expect(p0).toBeGreaterThan(0);
		}
	}
});

test("(7) no host-eligible or no remaining candidates defers, never supplies uniform mass", () => {
	const input = fixture();
	for (const eligibility of [
		[],
		input.eligibility.map((row) => ({
			...row,
			eligible: false,
			reason: "not authorized",
		})),
	]) {
		const result = resolve({ ...input, eligibility });
		expect(result.resolution.status).toBe("deferred");
		expect(result.resolution.holdReason).toBe("no eligible candidate");
		expect(result.resolution.ranking).toEqual([]);
		expect(
			result.resolution.excluded.every((e) => e.stage === "host_eligibility"),
		).toBe(true);
		expect(result.spec).toBeNull();
	}
	const excluded = resolve(
		fixture("transition", undefined, (m) =>
			m === "clotho" ? opinion("oppose", "infeasible") : opinion("accept"),
		),
	);
	expect(excluded.resolution.status).toBe("deferred");
	expect(excluded.spec).toBeNull();
	expect(resolve(fixture("user_request", [])).resolution.status).toBe(
		"deferred",
	);
	expect(() =>
		resolvePersonalRound({
			...input,
			eligibility: [
				...input.eligibility,
				{ optionKey: "unknown", eligible: true, reason: null },
			],
		}),
	).toThrow();
	const partial = resolve({
		...input,
		eligibility: input.eligibility.slice(1),
	});
	expect(
		requireSpec(partial).candidates.find(
			(c) => c.optionKey === option("a").optionKey,
		)?.p0,
	).toBe(0);
});

test("(7) eligible completeness precedes protection; ineligible candidates need no assessments", () => {
	const input = fixture("user_request", undefined, (m, o) =>
		m === "lachesis" && o.targetId === "a"
			? null
			: m === "atropos"
				? opinion("oppose", "commitment_breach")
				: opinion("accept"),
	);
	const result = resolve(input);
	expect(result.resolution.status).toBe("held");
	expect(result.resolution.holdReason).toBe(
		`missing assessment lachesis for ${option("a").optionKey}`,
	);
	expect(result.spec).toBeNull();
	const without = resolve({
		...input,
		eligibility: input.eligibility.filter(
			(e) => e.optionKey !== option("a").optionKey,
		),
	});
	expect(without.resolution.status).toBe("deferred");
	const mismatched = {
		...input,
		snapshot: { ...input.snapshot, workingRevision: 1 },
	};
	expect(() => resolvePersonalRound(mismatched)).toThrow(/snapshot/);
	expect(() =>
		resolvePersonalRound({
			...input,
			set: { ...input.set, assessments: input.set.assessments.slice(1) },
		}),
	).toThrow();
});

for (const situation of SITUATIONS) {
	test(`(7b) ${situation}: unavailable drops a module transitively for every candidate`, () => {
		const [m1, m2] = orders[situation];
		const input = fixture(situation, undefined, (m, o) => {
			if (m === m1)
				return opinion(
					o.targetId === "a"
						? "prefer"
						: o.targetId === "b"
							? "accept"
							: "unavailable",
				);
			if (m === m2)
				return opinion(
					o.targetId === "a"
						? "oppose"
						: o.targetId === "b"
							? "prefer"
							: "accept",
				);
			return opinion("accept");
		});
		const result = resolve(input);
		expect(result.resolution.status).toBe("resolved");
		expect(result.resolution.ranking).toEqual(
			["b", "c", "a"].map((id, i) => ({
				optionKey: option(id).optionKey,
				rank: i + 1,
			})),
		);
		expect(result.resolution.abstentions).toContainEqual({
			optionKey: option("c").optionKey,
			moduleKind: m1,
			reason: "missing observation",
		});
		expect(
			resolve({ ...input, options: [...input.options].reverse() }),
		).toEqual(result);
	});
}

test("(7b) all modules unavailable for ordering holds and records every abstention", () => {
	const result = resolve(
		fixture(
			"transition",
			MODULE_KINDS.map((m) => option(m)),
			(m, o) => opinion(m === o.targetId ? "unavailable" : "accept"),
		),
	);
	expect(result.resolution.status).toBe("held");
	expect(result.resolution.holdReason).toBe(
		"all modules unavailable for ordering",
	);
	expect(result.resolution.abstentions).toHaveLength(3);
	expect(result.spec).toBeNull();
});

test("unavailable on an excluded option is recorded but does not drop ordering modules", () => {
	const input = fixture("user_request", undefined, (m, o) =>
		o.targetId === "c"
			? opinion("unavailable")
			: opinion(m === "atropos" && o.targetId === "a" ? "prefer" : "accept"),
	);
	const result = resolve({
		...input,
		eligibility: input.eligibility.filter(
			(e) => e.optionKey !== option("c").optionKey,
		),
	});
	expect(result.resolution.status).toBe("resolved");
	expect(result.resolution.abstentions).toHaveLength(3);
	expect(result.resolution.ranking.at(0)).toEqual({
		optionKey: option("a").optionKey,
		rank: 1,
	});
});

test("(9) normalized duplicate options cannot double activity mass", () => {
	const o = option("a");
	const input = fixture("user_request", [o]);
	const variant = buildCanonicalOption({
		...o,
		targetId: " a ",
		args: { omitted: " " },
	});
	expect(() =>
		resolvePersonalRound({ ...input, options: [o, variant] }),
	).toThrow("duplicate option key");
});

test("(10) single positive candidate consumes no draw, including NaN", () => {
	const spec = samplingSpec([
		{ optionKey: "a", p0: 0, b: 1000 },
		{ optionKey: "b", p0: 1, b: null },
	]);
	expect(sampleSelection(spec, NaN)).toEqual({
		optionKey: "b",
		probabilities: [
			{ optionKey: "a", p: 0 },
			{ optionKey: "b", p: 1 },
		],
		consumedDraw: false,
	});
});

test("(10) sampling uses normalized log weights and strict cumulative boundaries", () => {
	const spec = samplingSpec([
		{ optionKey: "a", p0: 0.5, b: Math.log(3) },
		{ optionKey: "b", p0: 0.5, b: 0 },
	]);
	const sample = sampleSelection(spec, 0);
	expect(sample.optionKey).toBe("a");
	expect(sample.consumedDraw).toBe(true);
	expect(sample.probabilities[0]?.p).toBeCloseTo(0.75, 12);
	expect(sample.probabilities[1]?.p).toBeCloseTo(0.25, 12);
	expect(sampleSelection(spec, 0.9).optionKey).toBe("b");
	const boundary = sample.probabilities[0]?.p;
	if (boundary === undefined) throw Error("missing probability");
	expect(sampleSelection(spec, boundary).optionKey).toBe("b");
	for (const u of [1, -0.1, NaN, Infinity])
		expect(() => sampleSelection(spec, u)).toThrow("invalid selection draw");
	const unmodulated = sampleSelection(samplingSpec(spec.candidates, 0), 0.5);
	expect(unmodulated.probabilities.map((c) => c.p)).toEqual([0.5, 0.5]);
	expect(unmodulated.optionKey).toBe("b");
});

test("(10) asymmetric and extreme log-space weights remain finite and normalized", () => {
	const spec = samplingSpec([
		{ optionKey: "a", p0: 0.8, b: 0.5 },
		{ optionKey: "b", p0: 0.2, b: -0.5 },
	]);
	const { probabilities } = sampleSelection(spec, 0);
	const [a, b] = probabilities;
	if (!a || !b) throw Error("missing probabilities");
	expect(Math.abs(a.p + b.p - 1)).toBeLessThanOrEqual(1e-12);
	expect(Math.abs(a.p / b.p - 4 * Math.E)).toBeLessThanOrEqual(1e-9);
	for (const candidates of [
		[
			{ optionKey: "a", p0: 1e-300, b: null },
			{ optionKey: "b", p0: 1, b: null },
		],
		[
			{ optionKey: "a", p0: 0.5, b: 1000 },
			{ optionKey: "b", p0: 0.5, b: 999 },
		],
		[
			{ optionKey: "a", p0: 0.5, b: -1000 },
			{ optionKey: "b", p0: 0.5, b: -999 },
		],
	]) {
		const result = sampleSelection(
			samplingSpec(candidates),
			1 - Number.EPSILON,
		);
		expect(result.probabilities.every((c) => Number.isFinite(c.p))).toBe(true);
		expect(
			Math.abs(result.probabilities.reduce((sum, c) => sum + c.p, 0) - 1),
		).toBeLessThanOrEqual(1e-12);
	}
});

test("policy public type exposes exactly the revision-one declaration", () => {
	const policy: ArbitrationPolicy = PERSONAL_POLICY_V1;
	expect(policy).toEqual({
		policyId: "personal.v1",
		revision: 1,
		ratio: 0.5,
		orders,
		lambda: { user_request: 0, autonomous: 1, transition: 1 },
		stanceOrder: ["prefer", "accept", "oppose"],
	});
});
