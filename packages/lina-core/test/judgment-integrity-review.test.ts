import { expect, test } from "bun:test";
import {
	type IntentionRecord,
	parseIntentionRecord,
	transitionIntention,
} from "../src/agents/index.ts";

const at = "2026-09-12T00:00:00.000Z";
function suspendedIntention(): IntentionRecord {
	let record: IntentionRecord = {
		schemaVersion: 1,
		intentionId: "integrity-intention",
		agentId: "agent-1",
		scopeId: "scope-1",
		revision: 0,
		kind: "user_commitment",
		purposeRef: "purpose-1",
		text: "Complete the accepted task",
		acceptance: {
			sourceRef: "original-request",
			acceptedBy: "user",
			policyRevision: 1,
			acceptedAt: at,
		},
		priority: 0,
		deadline: null,
		completionCondition: "Outcome receipt",
		abortConditions: [],
		relatedIntentions: [],
		status: "proposed",
		history: [],
	};
	for (const to of ["adopted", "active", "suspended"] as const)
		record = transitionIntention(record, {
			to,
			reason: "Fixture transition",
			evidenceRef: to === "suspended" ? record.acceptance.sourceRef : null,
			at,
		});
	return record;
}

for (const evidenceRef of [null, "unrelated-request"]) {
	test(`3995131658: pure resume rejects ${String(evidenceRef)} evidence`, () => {
		const record = suspendedIntention();
		const before = structuredClone(record);
		expect(() =>
			transitionIntention(record, {
				to: "active",
				reason: "Resume",
				evidenceRef,
				at,
			}),
		).toThrow("intention change requires original acceptance ref");
		expect(record).toEqual(before);
	});

	test(`3995131658: history parsing rejects ${String(evidenceRef)} resume evidence`, () => {
		const record = suspendedIntention();
		expect(() =>
			parseIntentionRecord({
				...record,
				status: "active",
				revision: record.revision + 1,
				history: [
					...record.history,
					{
						from: "suspended",
						to: "active",
						reason: "Resume",
						evidenceRef,
						at,
					},
				],
			}),
		).toThrow("intention change requires original acceptance ref");
	});
}

test("3995131658: resume preserves the original acceptance and round-trips", () => {
	const record = suspendedIntention();
	const resumed = transitionIntention(record, {
		to: "active",
		reason: "Resume",
		evidenceRef: record.acceptance.sourceRef,
		at,
	});
	expect(resumed.acceptance).toEqual(record.acceptance);
	expect(resumed.status).toBe("active");
	expect(resumed.revision).toBe(record.revision + 1);
	expect(parseIntentionRecord(JSON.parse(JSON.stringify(resumed)))).toEqual(
		resumed,
	);
});
