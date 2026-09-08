import { expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function workSource() {
	return {
		kind: "work",
		deliveryId: "delivery-1",
		operation: "upsert",
		sourceDigest: "a".repeat(64),
		policyRevision: 1,
		receipt: {
			receiptId: "receipt-1",
			receiptRevision: 1,
			supersedesRevision: null,
			taskId: "task-1",
			turnId: "turn-1",
			taskRevision: 2,
			ownerAgentId: "lina",
			participantAgentIds: ["lina"],
			attributionStatus: "known",
			outcome: "turn_ended",
			correction: null,
			evidenceDigest: lifeDigest([]),
		},
		fields: {
			categoryId: "research",
			outcome: "turn_ended",
			participantAgentIds: ["lina"],
			summary: "A finished research session",
		},
	};
}
function input(source = workSource()) {
	return {
		version: 2,
		worldId: "test-world",
		id: source.deliveryId,
		sourceRevision: source.receipt.receiptRevision,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
}

test("work input preserves typed receipt and consent proof without widening application v1", () => {
	const parsed = parseLifeInput(input());
	expect(isDeepStrictEqual(parsed, input())).toBe(true);
	expect(() => parseLifeInput({ ...input(), version: 1 })).toThrow();
	const application = {
		kind: "application",
		sourceId: "old",
		text: "old input",
	};
	const old = {
		version: 1,
		worldId: "test-world",
		id: "old",
		sourceRevision: 1,
		payloadDigest: lifeDigest(application),
		source: application,
		consumedLifeRevision: null,
	};
	expect(isDeepStrictEqual(parseLifeInput(old), old)).toBe(true);
	expect(() => parseLifeInput({ ...old, version: 2 })).toThrow();
});

test("the generic application input port cannot admit trusted work receipts", () => {
	const fixture = autonomyStoreFixture();
	try {
		expect(() => fixture.store.admitLifeInput(parseLifeInput(input()))).toThrow(
			/work|trusted/i,
		);
	} finally {
		fixture.close();
	}
});

test("work inputs reject unknown attribution claims, disclosure escalation and mismatched identities", () => {
	const base = workSource();
	for (const source of [
		{ ...base, operation: "success" },
		{ ...base, receipt: { ...base.receipt, attributionStatus: "unknown" } },
		{ ...base, fields: { ...base.fields, participantAgentIds: ["mira"] } },
		{ ...base, fields: { ...base.fields, outcome: "verified_result" } },
		{
			...base,
			receipt: {
				...base.receipt,
				receiptRevision: 2,
				supersedesRevision: null,
			},
		},
		{ ...base, receipt: { ...base.receipt, cwd: "/secret" } },
	])
		expect(() => parseLifeInput(input(source))).toThrow();
	expect(() =>
		parseLifeInput({ ...input(), id: "another-delivery" }),
	).toThrow();
	expect(() => parseLifeInput({ ...input(), sourceRevision: 99 })).toThrow();
	expect(() =>
		parseLifeInput({ ...input(), payloadDigest: "b".repeat(64) }),
	).toThrow();
});
