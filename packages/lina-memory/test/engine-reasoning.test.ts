import { expect, test } from "bun:test";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import {
	contentHash,
	parseConclusions,
	prepareConclusions,
} from "../src/engine/reasoning.ts";
import { deriveRecord } from "../src/engine/records.ts";
import type { EngineRecord, SourceEntry } from "../src/engine/types.ts";
import { ordinarySource, restrictSource } from "./fixtures/native-sources.ts";

function fixture() {
	const entries = new Map<string, SourceEntry>(
		["u1", "u2", "uncited"].map((id) => [
			id,
			ordinarySource({ entryId: id, role: "user", text: "I like walking." }),
		]),
	);
	const lookup = (id: string) => entries.get(id);
	const records = new Map<string, EngineRecord>();
	const add = (
		key: string,
		entryId: string,
		evidence: "explicit" | "inferred" = "explicit",
	) => {
		const record = {
			...deriveRecord(
				"lina",
				{
					subject: "user",
					kind: "interest",
					key,
					text: "Likes walking",
					evidence,
					sources: [{ entryId, quote: "walking" }],
				},
				undefined,
				1,
				1800000000000,
				lookup,
			),
			sourceRequestId: `observation-${key}`,
			sourceProofs: captureSourceProofs([entryId], lookup),
		};
		records.set(record.id, record);
		return record;
	};
	const a = add("walking", "u1");
	const b = add("outdoors", "u2");
	const proposal = {
		subject: "user" as const,
		kind: "interest" as const,
		key: "parks",
		text: "May enjoy parks",
		reasoningKind: "induction" as const,
		premises: [
			{ recordId: a.id, revision: a.revision },
			{ recordId: b.id, revision: b.revision },
		],
	};
	const prepare = (proposals: unknown = [proposal]) =>
		prepareConclusions({
			agentId: "lina",
			proposals,
			resolve: (id: string) => records.get(id),
			promptProofs: captureSourceProofs([...entries.keys()], lookup),
			lookup,
			now: 1800000000000,
		});
	return { entries, lookup, records, add, a, b, proposal, prepare };
}

test("strict proposals cannot forge provenance, identity or support", () => {
	const f = fixture();
	for (const extra of [
		{ sourceProofs: [] },
		{ support: "supported" },
		{ agentId: "other" },
		{ evidence: "explicit" },
		{ status: "retracted" },
	]) {
		expect(() => parseConclusions([{ ...f.proposal, ...extra }])).toThrow();
	}
	expect(() => parseConclusions([f.proposal, f.proposal])).toThrow(/duplicate/);
	expect(parseConclusions([])).toEqual([]);
});

test("induction stays provisional and binds uncited prompt context", () => {
	const f = fixture();
	const result = f.prepare()[0];
	expect(result?.support).toBe("provisional");
	expect(result?.sourceProofs.map((p) => p.entryId)).toEqual([
		"u1",
		"u2",
		"uncited",
	]);
	expect(result?.sources.map((s) => s.entryId)).toEqual(["u1", "u2"]);
	expect(result?.reasoning.premises[0]?.contentHash).toBe(contentHash(f.a));
	const inputProofs = captureSourceProofs([...f.entries.keys()], f.lookup);
	const uncited = f.entries.get("uncited");
	if (!uncited) throw Error("missing fixture source");
	restrictSource(uncited);
	expect(() =>
		prepareConclusions({
			agentId: "lina",
			proposals: [f.proposal],
			resolve: (id) => f.records.get(id),
			promptProofs: inputProofs,
			lookup: f.lookup,
			now: 1800000000000,
		}),
	).toThrow(/provenance/);
});

test("deduction support never exceeds its least certain premise", () => {
	const f = fixture();
	expect(
		f.prepare([{ ...f.proposal, reasoningKind: "deduction" }])[0]?.support,
	).toBe("supported");
	const uncertain = f.add("guess", "u1", "inferred");
	expect(
		f.prepare([
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [{ recordId: uncertain.id, revision: uncertain.revision }],
			},
		])[0]?.support,
	).toBe("provisional");
});

test("reconfirmation preserves content identity but correction changes it", () => {
	const f = fixture();
	expect(contentHash({ ...f.a, revision: 9, updatedAt: 1800000000010 })).toBe(
		contentHash(f.a),
	);
	expect(
		contentHash({ ...f.a, text: "Dislikes walking", generation: 1 }),
	).not.toBe(contentHash(f.a));
	expect(() =>
		f.prepare([
			{ ...f.proposal, premises: [{ recordId: f.a.id, revision: 0 }] },
		]),
	).toThrow(/revision/);
});

test("missing, foreign, expired and self premises are rejected", () => {
	const f = fixture();
	expect(() =>
		f.prepare([
			{ ...f.proposal, premises: [{ recordId: "missing", revision: 1 }] },
		]),
	).toThrow();
	f.records.set(f.a.id, { ...f.a, agentId: "other" });
	expect(() => f.prepare()).toThrow();
	f.records.set(f.a.id, { ...f.a, expiresAt: 1 });
	expect(() => f.prepare()).toThrow();
	f.records.set(f.a.id, f.a);
	expect(() =>
		f.prepare([
			{
				...f.proposal,
				key: f.a.key,
				premises: [{ recordId: f.a.id, revision: 1 }],
			},
		]),
	).toThrow(/cycle/);
});

test("a premise chain cannot hide a corrected ancestor or a cycle through an older revision", () => {
	const f = fixture();
	const derived = f.add("derived", "u1", "inferred");
	derived.reasoning = {
		kind: "deduction",
		premises: [
			{
				recordId: f.a.id,
				revision: f.a.revision,
				contentHash: contentHash(f.a),
			},
		],
	};
	const proposal = {
		...f.proposal,
		premises: [{ recordId: derived.id, revision: derived.revision }],
	};
	expect(f.prepare([proposal])).toHaveLength(1);
	f.records.set(f.a.id, {
		...f.a,
		text: "Now dislikes walking",
		generation: 1,
		revision: 2,
	});
	expect(() => f.prepare([proposal])).toThrow(/content/);
	f.records.set(f.a.id, f.a);
	expect(() => f.prepare([{ ...proposal, key: f.a.key }])).toThrow(/cycle/);
});
