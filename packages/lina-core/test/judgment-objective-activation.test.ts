import { expect, test } from "bun:test";
import {
	JudgmentStore,
	MODULE_KINDS,
	type ModuleKind,
	resolvePersonalRound,
} from "../src/agents/index.ts";
import { policyEvidenceFixture } from "./judgment-policy-evidence-fixture.ts";

function replacement(
	f: ReturnType<typeof policyEvidenceFixture>,
	moduleKind: ModuleKind,
	revision: number,
) {
	const ref = f.input.snapshot.objectiveProfileRefs[moduleKind];
	const profile = f.store.getObjectiveProfile(ref.objectiveId, ref.revision);
	if (!profile) throw Error("missing objective");
	return f.store.putObjectiveProfile({ ...profile, revision });
}

function assessed(f: ReturnType<typeof policyEvidenceFixture>) {
	f.store.closeCandidateSet(f.input.evidence.candidates);
	for (const assessment of f.input.set.assessments)
		f.store.putAssessment(assessment);
	return resolvePersonalRound(f.input);
}

for (const moduleKind of MODULE_KINDS)
	test(`3999233699 ${moduleKind} cannot reactivate a stale open round across reopen`, () => {
		const f = policyEvidenceFixture();
		try {
			const { agentId, scopeId, roundId, objectiveProfileRefs } =
				f.input.snapshot;
			const result = assessed(f);
			const a = objectiveProfileRefs[moduleKind];
			expect(
				f.store.activateObjectiveProfile(agentId, scopeId, a)
					.activationRevision,
			).toBe(1);
			const b = replacement(f, moduleKind, 2);
			expect(
				f.store.activateObjectiveProfile(agentId, scopeId, b)
					.activationRevision,
			).toBe(2);
			expect(() =>
				f.store.activateObjectiveProfile(agentId, scopeId, a),
			).toThrow("objective reactivation would revive stale round");
			const reopened = f.fixture.keep(new JudgmentStore(f.path));
			expect(
				reopened.activeObjectiveProfiles(agentId, scopeId)?.[moduleKind],
			).toEqual(b);
			expect(
				reopened.activateObjectiveProfile(agentId, scopeId, b)
					.activationRevision,
			).toBe(2);
			expect(() =>
				reopened.activateObjectiveProfile(agentId, scopeId, a),
			).toThrow("objective reactivation would revive stale round");
			expect(() =>
				reopened.recordResolution(roundId, result.resolution, result.spec),
			).toThrow("stale objective profile refs");
			// A fresh revision can express the original objective without reviving old work.
			const next = replacement(f, moduleKind, 3);
			expect(
				reopened.activateObjectiveProfile(agentId, scopeId, next)
					.activationRevision,
			).toBe(3);
			const refs = reopened.activeObjectiveProfiles(agentId, scopeId);
			if (!refs) throw Error("missing active objectives");
			const fresh = {
				...f.input.snapshot,
				roundId: "fresh",
				sequence: 2,
				objectiveProfileRefs: refs,
			};
			reopened.openRound(fresh);
			expect(f.store.getRound("fresh")?.snapshot).toEqual(fresh);
		} finally {
			f.fixture.close();
		}
	});

test("3999233699 rotating different modules cannot revive an old snapshot", () => {
	const f = policyEvidenceFixture();
	try {
		const { agentId, scopeId, objectiveProfileRefs } = f.input.snapshot;
		for (const moduleKind of ["clotho", "atropos"] as const)
			f.store.activateObjectiveProfile(
				agentId,
				scopeId,
				replacement(f, moduleKind, 2),
			);
		// Restoring only one module is safe while another still invalidates the round.
		expect(
			f.store.activateObjectiveProfile(
				agentId,
				scopeId,
				objectiveProfileRefs.clotho,
			).activationRevision,
		).toBe(3);
		expect(() =>
			f.store.activateObjectiveProfile(
				agentId,
				scopeId,
				objectiveProfileRefs.atropos,
			),
		).toThrow("objective reactivation would revive stale round");
	} finally {
		f.fixture.close();
	}
});

for (const other of ["agent", "scope"] as const)
	test(`3999233699 an open round does not block another ${other}`, () => {
		const f = policyEvidenceFixture();
		try {
			const { agentId, scopeId, objectiveProfileRefs } = f.input.snapshot;
			const agent = other === "agent" ? "other-agent" : agentId;
			const scope = other === "scope" ? "other-scope" : scopeId;
			for (const ref of Object.values(objectiveProfileRefs))
				f.store.activateObjectiveProfile(agent, scope, ref);
			f.store.activateObjectiveProfile(
				agent,
				scope,
				replacement(f, "clotho", 2),
			);
			expect(
				f.store.activateObjectiveProfile(
					agent,
					scope,
					objectiveProfileRefs.clotho,
				).activationRevision,
			).toBe(3);
		} finally {
			f.fixture.close();
		}
	});

test("3999233699 closed rounds remain replayable after objective reactivation", () => {
	const f = policyEvidenceFixture();
	try {
		const { agentId, scopeId, roundId, objectiveProfileRefs } =
			f.input.snapshot;
		const result = assessed(f);
		f.store.recordResolution(roundId, result.resolution, result.spec);
		f.store.activateObjectiveProfile(
			agentId,
			scopeId,
			replacement(f, "clotho", 2),
		);
		expect(
			f.store.activateObjectiveProfile(
				agentId,
				scopeId,
				objectiveProfileRefs.clotho,
			).activationRevision,
		).toBe(3);
		const reopened = f.fixture.keep(new JudgmentStore(f.path));
		expect(reopened.getResolution(roundId)).toEqual(result.resolution);
		expect(reopened.getSelectionSpec(roundId)).toEqual(result.spec);
	} finally {
		f.fixture.close();
	}
});
