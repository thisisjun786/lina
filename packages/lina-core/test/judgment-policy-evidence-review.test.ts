import { afterEach, expect, test } from "bun:test";
import { buildCandidateSet } from "../src/agents/judgment-candidates.ts";
import { buildCanonicalOption } from "../src/agents/judgment-catalog.ts";
import {
	PERSONAL_POLICY_V1,
	resolvePersonalRound,
} from "../src/agents/judgment-policy.ts";
import { intentionDigest } from "../src/agents/judgment-validation.ts";
import {
	policyEvidenceFixture,
	policyOption,
} from "./judgment-policy-evidence-fixture.ts";

const fixtures: ReturnType<typeof policyEvidenceFixture>[] = [];
function setup(option = policyOption()) {
	const fixture = policyEvidenceFixture(option);
	fixtures.push(fixture);
	return fixture;
}
afterEach(() => {
	for (const { fixture } of fixtures.splice(0)) fixture.close();
});

test("personal.v1 declares its closed unavailable reason vocabulary", () => {
	expect(PERSONAL_POLICY_V1).toMatchObject({
		unavailableReasons: ["insufficient_evidence"],
	});
});

// Exclusion reasons are parsed receipt fields: missing evidence and an explicit
// negative Host decision must not become the same recorded state.
test("explicit Host false/null is distinct from an absent eligibility row", () => {
	const { input } = setup();
	const { evidence: _evidence, ...direct } = input;
	direct.eligibility = direct.eligibility.map((row) => ({
		...row,
		eligible: false,
	}));
	const explicit = resolvePersonalRound(direct);
	const missing = resolvePersonalRound({ ...direct, eligibility: [] });
	expect(explicit.resolution.status).toBe("deferred");
	expect(explicit.resolution.excluded[0]?.stage).toBe("host_eligibility");
	expect(explicit.resolution.excluded[0]?.reason).not.toBe(
		missing.resolution.excluded[0]?.reason,
	);
});

for (const kind of ["noop", "intention.suspend", "intention.cancel"] as const)
	for (const ids of [undefined, []])
		test(`Atropos unattributed ${kind} opposition cannot hard-veto (${JSON.stringify(ids)})`, () => {
			const { input, oppose } = setup(policyOption(kind));
			oppose("atropos", ids);
			const result = resolvePersonalRound(input);
			expect(result.resolution.excluded).toEqual([]);
			expect(result.spec?.candidates[0]?.p0).toBe(1);
		});

for (const ids of [["invented"], ["promise"]])
	test(`direct resolver cannot trust unverified attribution ${JSON.stringify(ids)}`, () => {
		const { input, oppose } = setup();
		oppose("atropos", ids);
		const { evidence: _evidence, ...direct } = input;
		const result = resolvePersonalRound(direct);
		expect(result.resolution.excluded).toEqual([]);
		expect(result.spec?.candidates[0]?.p0).toBe(1);
	});

test("Host-eligible Clotho infeasible opinion alone remains ranked opposition", () => {
	const { input, oppose } = setup();
	oppose("clotho");
	const result = resolvePersonalRound(input);
	expect(result.resolution.excluded).toEqual([]);
	expect(result.spec?.candidates[0]?.p0).toBe(1);
});

test("factual prerequisite failure is represented by Host eligibility", () => {
	const { input, oppose } = setup();
	oppose("clotho");
	const { evidence: _evidence, ...direct } = input;
	direct.eligibility = direct.eligibility.map((row) => ({
		...row,
		eligible: false,
		reason: "prerequisite receipt: unavailable resource",
	}));
	const result = resolvePersonalRound(direct);
	expect(result.resolution.excluded[0]?.stage).toBe("host_eligibility");
	expect(result.spec).toBeNull();
});

test("owner-verified accepted commitment still hard-vetoes an ordinary candidate", () => {
	const { input, oppose } = setup();
	oppose("atropos", ["promise"]);
	const result = resolvePersonalRound(input);
	expect(result.resolution.excluded[0]?.stage).toBe("commitment_protection");
	expect(result.spec).toBeNull();
});

for (const kind of ["intention.suspend", "intention.cancel"] as const)
	test(`verified same-target ${kind} retains its original-acceptance waiver`, () => {
		const { input, oppose } = setup(policyOption(kind));
		oppose("atropos", ["promise"]);
		const result = resolvePersonalRound(input);
		expect(result.resolution.excluded).toEqual([]);
		expect(result.spec?.candidates[0]?.p0).toBe(1);
	});

for (const forgery of [
	"id",
	"digest",
	"scope",
	"lookup",
	"candidate-universe",
	"snapshot",
	"kind",
	"status",
] as const)
	test(`direct resolver rejects ${forgery} evidence instead of manufacturing a veto`, () => {
		const { input, oppose, adopted } = setup();
		oppose("atropos", [forgery === "id" ? "invented" : "promise"]);
		const { candidateDigest: _digest, ...candidates } =
			input.evidence.candidates;
		if (forgery === "digest")
			input.evidence.candidates = buildCandidateSet({
				...candidates,
				intentionRefs: candidates.intentionRefs.map((ref) => ({
					...ref,
					digest: "invented",
				})),
			});
		if (forgery === "scope")
			input.evidence.lookupIntention = () => ({
				...adopted,
				scopeId: "foreign",
			});
		if (forgery === "lookup") input.evidence.lookupIntention = () => null;
		if (forgery === "candidate-universe")
			input.evidence.candidates = buildCandidateSet({
				...candidates,
				eligibility: [],
			});
		if (forgery === "snapshot")
			input.evidence.candidates = buildCandidateSet({
				...candidates,
				snapshotDigest: "invented",
			});
		if (forgery === "kind")
			input.evidence.lookupIntention = () => ({
				...adopted,
				kind: "autonomous_goal",
			});
		if (forgery === "status")
			input.evidence.candidates = buildCandidateSet({
				...candidates,
				intentionRefs: candidates.intentionRefs.map((ref) => ({
					...ref,
					status: "proposed",
				})),
			});
		expect(() => resolvePersonalRound(input)).toThrow();
	});

for (const ids of [["other"], ["promise", "other"]])
	test(`targeted waiver cannot release another verified promise ${JSON.stringify(ids)}`, () => {
		const { input, oppose, store, adopted } = setup(
			policyOption("intention.cancel"),
		);
		store.putIntention({
			...adopted,
			intentionId: "other",
			status: "proposed",
			revision: 0,
			history: [],
		});
		const other = store.transitionIntention(
			"other",
			{
				to: "adopted",
				reason: "accept",
				evidenceRef: "accepted-request",
				at: "2026-09-12T00:00:00.000Z",
			},
			0,
		);
		const { candidateDigest: _digest, ...candidates } =
			input.evidence.candidates;
		input.evidence.candidates = buildCandidateSet({
			...candidates,
			intentionRefs: [
				...candidates.intentionRefs,
				{
					intentionId: other.intentionId,
					revision: other.revision,
					status: other.status,
					digest: intentionDigest(other),
				},
			],
		});
		oppose("atropos", ids);
		const result = resolvePersonalRound(input);
		expect(result.resolution.excluded[0]?.stage).toBe("commitment_protection");
		expect(result.spec).toBeNull();
	});

test("a nonempty invented acceptance reference cannot obtain a waiver", () => {
	const { input, oppose } = setup(policyOption("intention.cancel", "invented"));
	oppose("atropos", ["promise"]);
	expect(() => resolvePersonalRound(input)).toThrow(
		"candidate original acceptance mismatch",
	);
});

test("a waiver cannot name a different canonical target", () => {
	const option = buildCanonicalOption({
		...policyOption("intention.cancel"),
		targetId: "different",
	});
	const { input, oppose } = setup(option);
	oppose("atropos", ["promise"]);
	expect(() => resolvePersonalRound(input)).toThrow(
		"candidate intention target mismatch",
	);
});
