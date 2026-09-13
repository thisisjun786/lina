import { join } from "node:path";
import { type IntentionRecord, MODULE_KINDS } from "../src/agents/judgment.ts";
import {
	buildCandidateSet,
	type CandidateSet,
} from "../src/agents/judgment-candidates.ts";
import {
	buildCanonicalOption,
	type CanonicalOption,
} from "../src/agents/judgment-catalog.ts";
import {
	PERSONAL_POLICY_V1,
	type resolvePersonalRound,
} from "../src/agents/judgment-policy.ts";
import { JudgmentStore } from "../src/agents/judgment-store.ts";
import {
	assessmentInputDigest,
	intentionDigest,
	parseAssessmentSet,
	snapshotDigest,
} from "../src/agents/judgment-validation.ts";
import { Fixture } from "./fixture.ts";

const actor = { agentId: "policy-agent", scopeId: "policy-scope" };
const at = "2026-09-12T00:00:00.000Z";
export function policyOption(
	kind: "noop" | "intention.suspend" | "intention.cancel" = "noop",
	acceptanceSourceRef = "accepted-request",
): CanonicalOption {
	const common = {
		actor,
		targetId: kind === "noop" ? null : "promise",
		args: {},
	};
	switch (kind) {
		case "noop":
			return buildCanonicalOption({
				...common,
				kind,
				preconditions: { kind, reason: "wait" },
			});
		case "intention.suspend":
			return buildCanonicalOption({
				...common,
				kind,
				preconditions: {
					kind,
					intentionId: "promise",
					acceptanceSourceRef,
					reason: "pause",
				},
			});
		case "intention.cancel":
			return buildCanonicalOption({
				...common,
				kind,
				preconditions: {
					kind,
					intentionId: "promise",
					acceptanceSourceRef,
					authorityRef: "authority",
					userConfirmationRef: "confirmation",
				},
			});
	}
}
export function policyEvidenceFixture(option = policyOption()) {
	const fixture = new Fixture();
	const path = join(fixture.dir, "policy.sqlite");
	const store = fixture.keep(new JudgmentStore(path, { now: () => 1234 }));
	for (const moduleKind of MODULE_KINDS) {
		const ref = store.putObjectiveProfile({
			schemaVersion: 1,
			objectiveId: moduleKind,
			moduleKind,
			revision: 1,
			objective: "compare",
			comparisonCriteria: [],
			reconsiderationConditions: [],
		});
		store.activateObjectiveProfile(actor.agentId, actor.scopeId, ref);
	}
	const objectiveProfileRefs = store.activeObjectiveProfiles(
		actor.agentId,
		actor.scopeId,
	);
	if (!objectiveProfileRefs) throw Error("missing profiles");
	const snapshot = {
		schemaVersion: 1 as const,
		roundId: "policy-evidence-round",
		...actor,
		sourceRefs: [],
		workingRevision: 0,
		instructionRevision: 0,
		policyId: PERSONAL_POLICY_V1.policyId,
		policyRevision: 1,
		identityRevision: 0,
		domainRevisions: {},
		intentionRevision: 0,
		objectiveProfileRefs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "autonomous" as const,
		clockId: "clock",
		sequence: 1,
		bindingGeneration: 0,
	};
	const proposed: IntentionRecord = {
		schemaVersion: 1,
		intentionId: "promise",
		...actor,
		revision: 0,
		kind: "user_commitment",
		purposeRef: "purpose",
		text: "keep promise",
		acceptance: {
			sourceRef: "accepted-request",
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
	};
	store.putIntention(proposed);
	const adopted = store.transitionIntention(
		"promise",
		{ to: "adopted", reason: "accept", evidenceRef: "accepted-request", at },
		0,
	);
	snapshot.intentionRevision = store.intentionRevision(
		actor.agentId,
		actor.scopeId,
	);
	store.openRound(snapshot);
	const candidates = buildCandidateSet({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		options: [option],
		eligibility: [
			{ optionKey: option.optionKey, eligible: true, reason: null },
		],
		intentionRefs: [
			{
				intentionId: adopted.intentionId,
				revision: adopted.revision,
				status: adopted.status,
				digest: intentionDigest(adopted),
			},
		],
	});
	const set = parseAssessmentSet({
		schemaVersion: 1,
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		assessments: MODULE_KINDS.map((moduleKind) => {
			const ref = {
				snapshotDigest: snapshotDigest(snapshot),
				objectiveRef: objectiveProfileRefs[moduleKind],
				mechanismRevision: 1,
			};
			return {
				schemaVersion: 1,
				moduleKind,
				snapshotId: snapshot.roundId,
				...ref,
				inputDigest: assessmentInputDigest(ref),
				completeText: "assessment",
				evidenceRefs: [],
				proposedOptionKeys: [],
				recommendedOptionKeys: [],
				objectiveAssessments: [
					{
						optionKey: option.optionKey,
						stance: "accept",
						severity: null,
						unavailableReason: null,
						gain: "gain",
						loss: "loss",
						uncertainty: "unknown",
						evidenceRefs: [],
					},
				],
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
	const input: Parameters<typeof resolvePersonalRound>[0] & {
		evidence: {
			candidates: CandidateSet;
			lookupIntention: (id: string) => IntentionRecord | null;
		};
	} = {
		policy: PERSONAL_POLICY_V1,
		snapshot,
		options: candidates.options,
		eligibility: candidates.eligibility,
		set,
		bias: {},
		evidence: { candidates, lookupIntention: (id) => store.getIntention(id) },
	};
	function oppose(moduleKind: "atropos" | "clotho", ids?: string[]) {
		const opinion = input.set.assessments.find(
			(a) => a.moduleKind === moduleKind,
		)?.objectiveAssessments[0];
		if (!opinion) throw Error("missing opinion");
		opinion.stance = "oppose";
		opinion.severity =
			moduleKind === "atropos" ? "commitment_breach" : "infeasible";
		if (ids !== undefined) opinion.breachedIntentionIds = ids;
	}
	return { fixture, store, path, input, oppose, adopted, option };
}
