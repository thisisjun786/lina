import { describe, expect, it } from "bun:test";
import {
	captureSourceProofs,
	isOrdinarySource,
	parseSourcePolicy,
	parseSourceProof,
	type SourceEntry,
	type SourcePolicy,
	sourcePolicyDigest,
	sourceProofsCurrent,
} from "../src/source-policy.ts";

function policy(patch: Partial<SourcePolicy> = {}): SourcePolicy {
	return {
		version: 1,
		scope: "ordinary",
		sessionId: "session",
		requestId: "request",
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		policyRevision: 1,
		contextReceiptIds: ["receipt"],
		materialKinds: ["shared-growth"],
		...patch,
	};
}
function source(patch: Partial<SourceEntry> = {}): SourceEntry {
	return {
		entryId: "user-1",
		role: "user",
		text: "I prefer concise answers",
		sourcePolicy: policy(),
		requestStatus: "settled",
		...patch,
	};
}

describe("trusted source policy", () => {
	it("requires settled ordinary provenance, never role or a raw content label", () => {
		expect(isOrdinarySource(source())).toBe(true);
		expect(isOrdinarySource(undefined)).toBe(false);
		const legacy = {
			entryId: "old",
			role: "user" as const,
			text: '{"scope":"ordinary"}',
		};
		expect(isOrdinarySource(legacy)).toBe(false);
		for (const scope of ["life", "mixed", "unclassified_legacy"] as const)
			expect(
				isOrdinarySource(source({ sourcePolicy: policy({ scope }) })),
			).toBe(false);
		for (const requestStatus of [
			"queued",
			"accepted",
			"interrupted",
			"rejected",
		] as const)
			expect(isOrdinarySource(source({ requestStatus }))).toBe(false);
		const { requestStatus: _status, ...missingStatus } = source();
		expect(isOrdinarySource(missingStatus)).toBe(false);
	});

	it("admits accepted context evidence only for the explicit trusted active request", () => {
		const active = source({ requestStatus: "accepted" });
		expect(isOrdinarySource(active, { activeRequestId: "request" })).toBe(true);
		expect(isOrdinarySource(active, { activeRequestId: "other" })).toBe(false);
		expect(
			isOrdinarySource(source({ requestStatus: "interrupted" }), {
				activeRequestId: "request",
			}),
		).toBe(false);
		expect(
			isOrdinarySource(
				source({
					requestStatus: "accepted",
					sourcePolicy: policy({ scope: "mixed" }),
				}),
				{ activeRequestId: "request" },
			),
		).toBe(false);
	});

	it("strictly validates version, binding, safe revisions, keys and material scope", () => {
		for (const patch of [
			{ version: 2 },
			{ extra: true },
			{ sessionId: "" },
			{ requestId: "\n" },
			{ nativeEpoch: 0 },
			{ policyRevision: Number.MAX_SAFE_INTEGER + 1 },
			{ scopeDigest: "fake" },
			{ contextReceiptIds: ["x", "x"] },
			{ materialKinds: ["shared-growth", "shared-growth"] },
			{ materialKinds: ["disclosed-life"] },
			{ materialKinds: ["author-world"] },
			{ scope: "factual" },
		])
			expect(() => parseSourcePolicy({ ...policy(), ...patch })).toThrow(
				/source/i,
			);
		expect(parseSourcePolicy(policy())).toEqual(policy());
	});

	it("canonicalizes set order and binds proofs to exact source policy", () => {
		const first = policy({
			scope: "mixed",
			contextReceiptIds: ["b", "a"],
			materialKinds: ["shared-growth", "disclosed-life"],
		});
		const second = policy({
			scope: "mixed",
			contextReceiptIds: ["a", "b"],
			materialKinds: ["disclosed-life", "shared-growth"],
		});
		expect(sourcePolicyDigest(first)).toBe(sourcePolicyDigest(second));
		expect(sourcePolicyDigest(policy({ requestId: "other" }))).not.toBe(
			sourcePolicyDigest(policy()),
		);
		const current = source();
		const proofs = captureSourceProofs(["user-1"], () => current);
		expect(proofs).toEqual([
			{
				entryId: "user-1",
				policyRevision: 1,
				policyDigest: sourcePolicyDigest(policy()),
			},
		]);
		const firstProof = proofs[0];
		if (!firstProof) throw Error("Missing test proof");
		expect(parseSourceProof(firstProof)).toEqual(firstProof);
		expect(() =>
			parseSourceProof({ ...proofs[0], policyRevision: 0 }),
		).toThrow();
		expect(() =>
			parseSourceProof({ ...proofs[0], scope: "ordinary" }),
		).toThrow();
	});

	it("rejects missing, mismatched, duplicate and stale evidence before and after async work", () => {
		let current = source();
		const lookup = () => current;
		const proofs = captureSourceProofs(["user-1"], lookup);
		expect(sourceProofsCurrent(proofs, lookup)).toBe(true);
		expect(() => captureSourceProofs([], lookup)).toThrow();
		expect(() => captureSourceProofs(["user-1", "user-1"], lookup)).toThrow();
		expect(() => captureSourceProofs(["missing"], () => undefined)).toThrow();
		expect(() => captureSourceProofs(["wrong-id"], lookup)).toThrow();
		expect(sourceProofsCurrent(proofs, () => undefined)).toBe(false);
		current = source({
			sourcePolicy: policy({
				policyRevision: 2,
				scope: "mixed",
				materialKinds: ["disclosed-life"],
				contextReceiptIds: ["receipt", "secret"],
			}),
		});
		expect(sourceProofsCurrent(proofs, lookup)).toBe(false);
		expect(() => captureSourceProofs(["user-1"], lookup)).toThrow();
		current = source({
			sourcePolicy: policy({
				policyRevision: 2,
				contextReceiptIds: ["receipt", "new-growth"],
			}),
		});
		expect(sourceProofsCurrent(proofs, lookup)).toBe(false);
		expect(sourceProofsCurrent([], lookup)).toBe(false);
	});
});
