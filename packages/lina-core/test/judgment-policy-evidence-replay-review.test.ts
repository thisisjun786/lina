import { afterEach, expect, test } from "bun:test";
import { resolvePersonalRound } from "../src/agents/judgment-policy.ts";
import { JudgmentStore } from "../src/agents/judgment-store.ts";
import {
	policyEvidenceFixture,
	policyOption,
} from "./judgment-policy-evidence-fixture.ts";

const fixtures: ReturnType<typeof policyEvidenceFixture>[] = [];
afterEach(() => {
	for (const { fixture } of fixtures.splice(0)) fixture.close();
});

for (const kind of ["noop", "intention.suspend", "intention.cancel"] as const)
	test(`owner-verified ${kind} arbitration records and replays after later intention transitions`, () => {
		const context = policyEvidenceFixture(policyOption(kind));
		fixtures.push(context);
		const { input, oppose, store, path, fixture } = context;
		oppose("atropos", ["promise"]);
		store.closeCandidateSet(input.evidence.candidates);
		for (const assessment of input.set.assessments)
			store.putAssessment(assessment);
		const result = resolvePersonalRound(input);
		const at = "2026-09-12T00:00:00.000Z";

		store.recordResolution(
			input.snapshot.roundId,
			result.resolution,
			result.spec,
		);
		store.transitionIntention(
			"promise",
			{ to: "active", reason: "start", evidenceRef: "accepted-request", at },
			1,
		);
		store.transitionIntention(
			"promise",
			{ to: "completed", reason: "finished", evidenceRef: "outcome", at },
			2,
		);
		const reopened = fixture.keep(new JudgmentStore(path));

		expect(reopened.getResolution(input.snapshot.roundId)).toEqual(
			result.resolution,
		);
		expect(reopened.getSelectionSpec(input.snapshot.roundId)).toEqual(
			result.spec,
		);
		expect(result.resolution.status).toBe(
			kind === "noop" ? "deferred" : "resolved",
		);
	});

for (const moduleKind of ["atropos", "clotho"] as const)
	test(`unattributed ${moduleKind} opposition persists without a veto`, () => {
		const context = policyEvidenceFixture();
		fixtures.push(context);
		const { input, oppose, store, fixture, path } = context;
		oppose(moduleKind);
		store.closeCandidateSet(input.evidence.candidates);
		for (const assessment of input.set.assessments)
			store.putAssessment(assessment);
		const result = resolvePersonalRound(input);

		store.recordResolution(
			input.snapshot.roundId,
			result.resolution,
			result.spec,
		);
		const reopened = fixture.keep(new JudgmentStore(path));

		expect(
			reopened.getSelectionSpec(input.snapshot.roundId)?.candidates[0]?.p0,
		).toBe(1);
		expect(
			reopened.getResolution(input.snapshot.roundId, "action")?.excluded,
		).toEqual([]);
	});
