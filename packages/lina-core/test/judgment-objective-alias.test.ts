import { expect, test } from "bun:test";
import {
	assessmentInputDigest,
	buildCandidateSet,
	judgmentDigest,
	MODULE_KINDS,
	parseJudgmentSnapshotRef,
	parseSelectionSpec,
	resolvePersonalRound,
	snapshotDigest,
} from "../src/agents/index.ts";
import { policyEvidenceFixture } from "./judgment-policy-evidence-fixture.ts";

for (const moduleKind of ["lachesis", "atropos"] as const)
	for (const changedDigest of [false, true])
		test(`3999164943 snapshot rejects ${moduleKind} alias with changed digest=${changedDigest}`, () => {
			const f = policyEvidenceFixture();
			try {
				const snapshot = structuredClone(f.input.snapshot);
				snapshot.objectiveProfileRefs[moduleKind] = {
					...snapshot.objectiveProfileRefs.clotho,
					...(changedDigest ? { digest: "another-digest" } : {}),
				};
				expect(() => parseJudgmentSnapshotRef(snapshot)).toThrow(
					"duplicate objective profile refs",
				);
			} finally {
				f.fixture.close();
			}
		});

test("3999164943 direct arbitration rejects aliased objectives with matching assessment digests", () => {
	const f = policyEvidenceFixture();
	try {
		const snapshot = structuredClone(f.input.snapshot);
		snapshot.objectiveProfileRefs.atropos =
			snapshot.objectiveProfileRefs.clotho;
		const digest = snapshotDigest(snapshot);
		const set = {
			...f.input.set,
			snapshotDigest: digest,
			assessments: f.input.set.assessments.map((assessment) => {
				const ref = {
					snapshotDigest: digest,
					objectiveRef: snapshot.objectiveProfileRefs[assessment.moduleKind],
					mechanismRevision: assessment.mechanismRevision,
				};
				return {
					...assessment,
					...ref,
					inputDigest: assessmentInputDigest(ref),
				};
			}),
		};
		const candidates = buildCandidateSet({
			roundId: snapshot.roundId,
			snapshotDigest: digest,
			options: f.input.options,
			eligibility: f.input.eligibility,
			intentionRefs: f.input.evidence.candidates.intentionRefs,
		});
		expect(() =>
			resolvePersonalRound({
				...f.input,
				snapshot,
				set,
				evidence: { ...f.input.evidence, candidates },
			}),
		).toThrow("duplicate objective profile refs");
	} finally {
		f.fixture.close();
	}
});

test("3999164943 selection parser rejects aliases even with a recomputed digest", () => {
	const f = policyEvidenceFixture();
	try {
		const { spec } = resolvePersonalRound(f.input);
		if (!spec) throw Error("missing selection");
		spec.objectiveProfileRefs.lachesis = spec.objectiveProfileRefs.clotho;
		spec.specDigest = judgmentDigest({ ...spec, specDigest: undefined });
		expect(() => parseSelectionSpec(spec)).toThrow(
			"duplicate objective profile refs",
		);
	} finally {
		f.fixture.close();
	}
});

test("3999164943 distinct stored revisions of one objective ID retain their module ownership", () => {
	const f = policyEvidenceFixture();
	try {
		for (const [index, moduleKind] of MODULE_KINDS.entries()) {
			const ref = f.store.putObjectiveProfile({
				schemaVersion: 1,
				objectiveId: "shared-objective",
				revision: index + 1,
				moduleKind,
				objective: "compare",
				comparisonCriteria: [],
				reconsiderationConditions: [],
			});
			f.store.activateObjectiveProfile(
				f.input.snapshot.agentId,
				f.input.snapshot.scopeId,
				ref,
			);
		}
		const refs = f.store.activeObjectiveProfiles(
			f.input.snapshot.agentId,
			f.input.snapshot.scopeId,
		);
		if (!refs) throw Error("missing active profiles");
		expect(
			parseJudgmentSnapshotRef({
				...f.input.snapshot,
				objectiveProfileRefs: refs,
			}).objectiveProfileRefs,
		).toEqual(refs);
	} finally {
		f.fixture.close();
	}
});
