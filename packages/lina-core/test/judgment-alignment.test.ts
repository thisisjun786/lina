import { afterEach, expect, test } from "bun:test";
import * as api from "../src/agents/index.ts";
import { policyEvidenceFixture } from "./judgment-policy-evidence-fixture.ts";

const fixtures: ReturnType<typeof policyEvidenceFixture>[] = [];
afterEach(() => {
	for (const item of fixtures.splice(0)) item.fixture.close();
});
function setup() {
	const item = policyEvidenceFixture();
	fixtures.push(item);
	return item;
}
function withRevision(
	input: ReturnType<typeof setup>["input"],
	revision: number,
) {
	const { evidence: _evidence, ...withoutEvidence } = input;
	const snapshot = { ...input.snapshot, policyRevision: revision };
	const digest = api.snapshotDigest(snapshot);
	const assessments = input.set.assessments.map((a) => {
		const next = { ...a, snapshotDigest: digest };
		return { ...next, inputDigest: api.assessmentInputDigest(next) };
	});
	return {
		...withoutEvidence,
		snapshot,
		set: { ...input.set, snapshotDigest: digest, assessments },
	};
}

test("current policy holds an unavailable opinion without rewriting revision one", () => {
	const { input } = setup();
	const opinion = input.set.assessments[1]?.objectiveAssessments[0];
	if (!opinion) throw Error("missing fixture opinion");
	opinion.stance = "unavailable";
	opinion.unavailableReason = "insufficient_evidence";
	const old = api.resolvePersonalRound(input);
	expect(old.resolution.status).toBe("resolved");
	const next = api.resolvePersonalRound({
		...withRevision(input, 2),
		policy: api.PERSONAL_POLICY_CURRENT,
	});
	expect(next.resolution.status).toBe("held");
	expect(next.spec).toBeNull();
	expect(next.resolution.ranking).toEqual([]);
	expect(next.resolution.conceded).toEqual([]);
	expect(next.resolution.abstentions).toHaveLength(1);
	expect(api.resolvePersonalRound(input)).toEqual(old);
	expect(() => api.personalPolicyFor("personal.v1", 3)).toThrow();
	expect(() => api.personalPolicyFor("invented", 2)).toThrow();
});

test("mechanism content hashes survive persistence and distinguish inputs", () => {
	const { input, store, path, fixture } = setup();
	const legacy = input.set.assessments[0];
	if (!legacy) throw Error("missing fixture assessment");
	const before = JSON.stringify(api.parseAssessment(legacy));
	const mechanismRevision = `sha256:${"a".repeat(64)}` as const;
	const next = { ...legacy, mechanismRevision };
	const parsed = api.parseAssessment({
		...next,
		inputDigest: api.assessmentInputDigest(next),
	});
	expect(parsed.mechanismRevision).toBe(mechanismRevision);
	expect(
		api.assessmentInputDigest({
			...next,
			mechanismRevision: `sha256:${"b".repeat(64)}`,
		}),
	).not.toBe(parsed.inputDigest);
	store.putAssessment(parsed);
	for (const other of input.set.assessments.slice(1))
		store.putAssessment(other);
	const reopened = fixture.keep(new api.JudgmentStore(path));
	expect(
		reopened.assessmentSet(input.snapshot.roundId).assessments,
	).toContainEqual(parsed);
	expect(JSON.stringify(api.parseAssessment(legacy))).toBe(before);
	for (const bad of [
		"1",
		"a".repeat(64),
		`sha256:${"A".repeat(64)}`,
		"sha256:abc",
	]) {
		expect(() =>
			api.parseAssessment({ ...parsed, mechanismRevision: bad }),
		).toThrow("invalid mechanism revision");
	}
});

test("fresh readout clips prose with provenance and leaves structured fields intact", () => {
	const { input, store } = setup();
	const source = input.set.assessments[0];
	if (!source) throw Error("missing fixture assessment");
	const { inputDigest: _digest, ...raw } = source;
	const text = `${"a".repeat(3999)}🧠tail`;
	const prepared = api.buildAssessment({ ...raw, completeText: text });
	expect(prepared.completeText).toBe("a".repeat(3999));
	expect(prepared.diagnostics["readoutTruncation"]).toMatchObject({
		originalLength: 4005,
		limit: 4000,
	});
	expect(prepared.objectiveAssessments).toEqual(source.objectiveAssessments);
	expect(prepared.inputDigest).toBe(source.inputDigest);
	store.putAssessment(prepared);
	for (const other of input.set.assessments.slice(1))
		store.putAssessment(other);
	expect(
		store.assessmentSet(input.snapshot.roundId).assessments,
	).toContainEqual(prepared);
	expect(() => api.parseAssessment({ ...source, completeText: text })).toThrow(
		"invalid complete text",
	);
	expect(api.buildAssessment(raw)).toEqual(source);
	expect(() =>
		api.buildAssessment({ ...raw, completeText: `${"a".repeat(5000)}\0` }),
	).toThrow();
	expect(() =>
		api.buildAssessment({ ...raw, recommendedOptionKeys: ["forged"] }),
	).toThrow();
});

test("fresh assessments reject supplied truncation provenance while legacy parsers preserve diagnostics", () => {
	const { input } = setup();
	const source = input.set.assessments[0];
	if (!source) throw Error("missing fixture assessment");
	const forged = {
		...source,
		diagnostics: {
			readoutTruncation: {
				originalLength: 5000,
				limit: 4000,
				sourceDigest: "a".repeat(64),
			},
		},
	};
	// Legacy diagnostics stay readable; fresh output owns its provenance.
	expect(api.parseAssessment(forged)).toEqual(forged);
	const { inputDigest: _digest, ...raw } = forged;
	for (const completeText of ["text", "a".repeat(5000)])
		expect(() => api.buildAssessment({ ...raw, completeText })).toThrow(
			"fresh assessment must not supply truncation metadata",
		);
});

test("a readout whose bound holds only whitespace is reported, never stored", () => {
	const { input } = setup();
	const source = input.set.assessments[0];
	if (!source) throw Error("missing fixture assessment");
	const { inputDigest: _digest, ...raw } = source;
	// The whole prose is valid, but its first 4,000 units carry no readable text.
	// Zero-width and other format characters render as nothing, like whitespace.
	for (const blank of [" ", "\n", "\u200b", "\ufeff"])
		expect(() =>
			api.buildAssessment({
				...raw,
				completeText: `${blank.repeat(4000)}answer`,
			}),
		).toThrow("complete text is empty within its bound");
	// Leading whitespace with text inside the bound still clips with provenance.
	const prepared = api.buildAssessment({
		...raw,
		completeText: `\u200b ${"a".repeat(4100)}`,
	});
	expect(prepared.completeText.length).toBe(4000);
	expect(prepared.diagnostics["readoutTruncation"]).toMatchObject({
		originalLength: 4102,
		limit: 4000,
	});
});
