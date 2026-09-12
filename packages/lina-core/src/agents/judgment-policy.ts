import {
	type AssessmentSet,
	type JudgmentSnapshotRef,
	MODULE_KINDS,
	type ModuleKind,
	type OptionAssessment,
	type OptionKey,
	type ResolutionRecord,
	type SelectionSpec,
	type Situation,
	type Stance,
} from "./judgment.ts";
import {
	type CanonicalOption,
	parseCanonicalOption,
} from "./judgment-catalog.ts";
import {
	judgmentDigest,
	parseAssessmentSet,
	parseResolutionRecord,
	parseSelectionSpec,
	snapshotDigest,
} from "./judgment-validation.ts";

export type ArbitrationPolicy = Readonly<{
	policyId: string;
	revision: number;
	ratio: number;
	orders: Readonly<Record<Situation, readonly ModuleKind[]>>;
	lambda: Readonly<Record<Situation, number>>;
	stanceOrder: readonly Stance[];
}>;
export const PERSONAL_POLICY_V1: ArbitrationPolicy = Object.freeze({
	policyId: "personal.v1",
	revision: 1,
	ratio: 0.5,
	orders: Object.freeze({
		user_request: Object.freeze(["atropos", "clotho", "lachesis"] as const),
		autonomous: Object.freeze(["lachesis", "clotho", "atropos"] as const),
		transition: Object.freeze(["clotho", "atropos", "lachesis"] as const),
	}),
	lambda: Object.freeze({ user_request: 0, autonomous: 1, transition: 1 }),
	stanceOrder: Object.freeze(["prefer", "accept", "oppose"] as const),
});
export type HostEligibility = Array<{
	optionKey: OptionKey;
	eligible: boolean;
	reason: string | null;
}>;

/** Each rank owns one geometric mass, regardless of how many candidates tie. */
export function rankMass(ranks: number[], ratio: number): number[] {
	if (!Number.isFinite(ratio) || ratio <= 0) throw Error("invalid rank ratio");
	const counts = new Map<number, number>();
	for (const rank of ranks) {
		if (!Number.isSafeInteger(rank) || rank < 1) throw Error("invalid rank");
		counts.set(rank, (counts.get(rank) ?? 0) + 1);
	}
	const total = [...counts.keys()].reduce(
		(sum, rank) => sum + ratio ** (rank - 1),
		0,
	);
	return ranks.map(
		(rank) => ratio ** (rank - 1) / total / (counts.get(rank) ?? 1),
	);
}

type Candidate = {
	option: CanonicalOption;
	opinions: Record<ModuleKind, OptionAssessment>;
};

export function resolvePersonalRound(input: {
	policy: ArbitrationPolicy;
	snapshot: JudgmentSnapshotRef;
	options: CanonicalOption[];
	set: AssessmentSet;
	eligibility: HostEligibility;
	bias: Record<OptionKey, number | null>;
}): { resolution: ResolutionRecord; spec: SelectionSpec | null } {
	const { policy, snapshot } = input;
	const options = input.options
		.map(parseCanonicalOption)
		.sort((a, b) =>
			a.optionKey < b.optionKey ? -1 : a.optionKey > b.optionKey ? 1 : 0,
		);
	const keys = new Set(options.map((o) => o.optionKey));
	if (keys.size !== options.length) throw Error("duplicate option key");
	const eligibility = new Map<OptionKey, HostEligibility[number]>();
	for (const row of input.eligibility) {
		if (!keys.has(row.optionKey)) throw Error("unknown eligibility option key");
		if (eligibility.has(row.optionKey))
			throw Error("duplicate eligibility option key");
		eligibility.set(row.optionKey, row);
	}
	const set = parseAssessmentSet(input.set);
	const digest = snapshotDigest(snapshot);
	if (set.roundId !== snapshot.roundId || set.snapshotDigest !== digest)
		throw Error("assessment set snapshot mismatch");
	const order = [...policy.orders[snapshot.situation]];
	const record: ResolutionRecord = {
		schemaVersion: 1,
		roundId: snapshot.roundId,
		policyId: policy.policyId,
		policyRevision: policy.revision,
		situation: snapshot.situation,
		order,
		recommendations: { clotho: [], lachesis: [], atropos: [] },
		conflicts: [],
		excluded: [],
		abstentions: [],
		ranking: [],
		conceded: [],
		status: "resolved",
		holdReason: null,
	};
	for (const assessment of set.assessments)
		record.recommendations[assessment.moduleKind] = [
			...assessment.recommendedOptionKeys,
		];
	const finishWithoutSpec = (
		status: "held" | "deferred",
		holdReason: string,
	) => ({
		resolution: parseResolutionRecord({ ...record, status, holdReason }),
		spec: null,
	});

	// 1-2: Host facts first; completeness is required only for eligible options.
	const eligible: Candidate[] = [];
	let missing: string | null = null;
	for (const option of options) {
		const row = eligibility.get(option.optionKey);
		const hostEligible = row?.eligible === true;
		if (!hostEligible)
			record.excluded.push({
				optionKey: option.optionKey,
				stage: "host_eligibility",
				byModule: null,
				reason: row?.reason ?? "missing host eligibility",
			});
		const opinions: Partial<Record<ModuleKind, OptionAssessment>> = {};
		for (const assessment of set.assessments) {
			const moduleKind = assessment.moduleKind;
			const opinion = assessment.objectiveAssessments.find(
				(o) => o.optionKey === option.optionKey,
			);
			if (opinion === undefined) {
				if (hostEligible && missing === null)
					missing = `missing assessment ${moduleKind} for ${option.optionKey}`;
				continue;
			}
			opinions[moduleKind] = opinion;
			if (opinion.unavailableReason !== null)
				record.abstentions.push({
					optionKey: option.optionKey,
					moduleKind,
					reason: opinion.unavailableReason,
				});
		}
		const { clotho, lachesis, atropos } = opinions;
		if (clotho && lachesis && atropos) {
			const complete = { clotho, lachesis, atropos };
			if (new Set(MODULE_KINDS.map((m) => complete[m].stance)).size > 1)
				record.conflicts.push({
					optionKey: option.optionKey,
					stances: {
						clotho: clotho.stance,
						lachesis: lachesis.stance,
						atropos: atropos.stance,
					},
				});
			if (hostEligible) eligible.push({ option, opinions: complete });
		}
	}
	if (missing !== null) return finishWithoutSpec("held", missing);

	// 3-4: Only the named module/severity can exclude at each stage.
	const remaining = eligible.filter(({ option, opinions }) => {
		const precondition = option.preconditions;
		const changesAcceptance =
			(precondition.kind === "intention.suspend" ||
				precondition.kind === "intention.cancel") &&
			precondition.acceptanceSourceRef.trim() !== "";
		if (
			opinions.atropos.stance === "oppose" &&
			opinions.atropos.severity === "commitment_breach" &&
			!changesAcceptance
		) {
			record.excluded.push({
				optionKey: option.optionKey,
				stage: "commitment_protection",
				byModule: "atropos",
				reason: "accepted commitment breach",
			});
			return false;
		}
		if (
			opinions.clotho.stance === "oppose" &&
			opinions.clotho.severity === "infeasible"
		) {
			record.excluded.push({
				optionKey: option.optionKey,
				stage: "infeasible",
				byModule: "clotho",
				reason: "infeasible precondition",
			});
			return false;
		}
		return true;
	});
	// 9: No candidate means deferred, not an empty ordering or uniform fallback.
	if (remaining.length === 0)
		return finishWithoutSpec("deferred", "no eligible candidate");

	// 5: Drop an unavailable module for the ENTIRE round, never per comparison.
	const orderingModules = order.filter((m) =>
		remaining.every((c) => c.opinions[m].stance !== "unavailable"),
	);
	if (orderingModules.length === 0)
		return finishWithoutSpec("held", "all modules unavailable for ordering");
	const compare = (a: Candidate, b: Candidate): number => {
		for (const moduleKind of orderingModules) {
			const difference =
				policy.stanceOrder.indexOf(a.opinions[moduleKind].stance) -
				policy.stanceOrder.indexOf(b.opinions[moduleKind].stance);
			if (difference !== 0) return difference;
		}
		return 0;
	};
	remaining.sort(compare);
	let rank = 0;
	let previous: Candidate | undefined;
	for (const candidate of remaining) {
		if (previous === undefined || compare(previous, candidate) !== 0) rank += 1;
		record.ranking.push({ optionKey: candidate.option.optionKey, rank });
		previous = candidate;
	}
	const winners = new Set(
		record.ranking.filter((r) => r.rank === 1).map((r) => r.optionKey),
	);
	for (const assessment of set.assessments) {
		for (const opinion of assessment.objectiveAssessments) {
			if (
				keys.has(opinion.optionKey) &&
				opinion.stance === "prefer" &&
				!winners.has(opinion.optionKey)
			)
				record.conceded.push({
					moduleKind: assessment.moduleKind,
					optionKey: opinion.optionKey,
				});
		}
	}

	// 6-8: Bias is copied only AFTER p0 has been produced and is never ranked.
	const masses = rankMass(
		record.ranking.map((r) => r.rank),
		policy.ratio,
	);
	const baseline = new Map(
		record.ranking.map((r, i) => [r.optionKey, masses[i] ?? 0]),
	);
	const candidates = options.map((o) => ({
		optionKey: o.optionKey,
		p0: baseline.get(o.optionKey) ?? 0,
		b: input.bias[o.optionKey] ?? null,
	}));
	if (!candidates.some((c) => c.p0 > 0))
		return finishWithoutSpec("deferred", "no eligible candidate");
	const resolution = parseResolutionRecord(record);
	const spec = {
		schemaVersion: 1 as const,
		roundId: snapshot.roundId,
		snapshotDigest: digest,
		assessmentSetDigest: judgmentDigest(set),
		objectiveProfileRefs: snapshot.objectiveProfileRefs,
		resolutionDigest: judgmentDigest(resolution),
		policyId: policy.policyId,
		policyRevision: policy.revision,
		situation: snapshot.situation,
		lambda: policy.lambda[snapshot.situation],
		candidates,
		eligibleDigest: judgmentDigest(
			candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
		),
	};
	return {
		resolution,
		spec: parseSelectionSpec({ ...spec, specDigest: judgmentDigest(spec) }),
	};
}

export function sampleSelection(
	spec: SelectionSpec,
	u: number,
): {
	optionKey: OptionKey;
	probabilities: Array<{ optionKey: OptionKey; p: number }>;
	consumedDraw: boolean;
} {
	const parsed = parseSelectionSpec(spec);
	const positive = parsed.candidates.filter((c) => c.p0 > 0);
	const single = positive.length === 1 ? positive.at(0) : undefined;
	if (single)
		return {
			optionKey: single.optionKey,
			probabilities: parsed.candidates.map((c) => ({
				optionKey: c.optionKey,
				p: c.p0 > 0 ? 1 : 0,
			})),
			consumedDraw: false,
		};
	if (!Number.isFinite(u) || u < 0 || u >= 1)
		throw Error("invalid selection draw");
	const logs = positive.map((c) => Math.log(c.p0) + parsed.lambda * (c.b ?? 0));
	const max = Math.max(...logs);
	const total = logs.reduce((sum, log) => sum + Math.exp(log - max), 0);
	const probabilities = parsed.candidates.map((c) => ({
		optionKey: c.optionKey,
		p:
			c.p0 === 0
				? 0
				: Math.exp(Math.log(c.p0) + parsed.lambda * (c.b ?? 0) - max) / total,
	}));
	let cumulative = 0;
	let lastPositive: OptionKey | undefined;
	for (const candidate of probabilities) {
		cumulative += candidate.p;
		if (candidate.p > 0) lastPositive = candidate.optionKey;
		if (cumulative > u)
			return {
				optionKey: candidate.optionKey,
				probabilities,
				consumedDraw: true,
			};
	}
	// Floating-point summation may leave a sub-tolerance tail below one.
	if (lastPositive !== undefined && Math.abs(cumulative - 1) <= 1e-12)
		return { optionKey: lastPositive, probabilities, consumedDraw: true };
	throw Error("invalid selection weights");
}
