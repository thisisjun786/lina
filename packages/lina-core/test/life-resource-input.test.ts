import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseResourceActivitySource } from "../src/world/work-activity-validation.ts";
import {
	parseWorkEvidence,
	parseWorkEvidenceV2,
} from "../src/world/work-validation.ts";
import { workInput } from "./life-work-fixture.ts";

function source() {
	return {
		kind: "resource_activity",
		version: 1,
		deliveryId: "delivery",
		operation: "upsert",
		sourceDigest: lifeDigest("admitted resource"),
		policyRevision: 1,
		receipt: {
			activityId: "activity",
			activityRevision: 1,
			supersedesRevision: null,
			resourceId: "resource",
			resourceRevision: 2,
			versionId: "version",
			memoryId: null,
			actorAgentId: "lina",
			participantAgentIds: ["lina"],
			activityKind: "search",
			outcome: "recorded",
			evidenceDigest: lifeDigest([]),
			grantId: "grant",
			grantRevision: 1,
			correction: null,
		},
		fields: {
			categoryId: "research",
			outcome: "recorded",
			participantAgentIds: ["lina"],
			summary: "Searched source material",
		},
	};
}
test("resource activity source keeps taskless attribution and recorded outcome", () => {
	expect(parseResourceActivitySource(source())).toMatchObject(source());
	expect(
		parseResourceActivitySource({
			...source(),
			operation: "restrict",
			fields: null,
		}).fields,
	).toBeNull();
});
test("resource activity rejects synthetic task fields, unknown actors and false success", () => {
	for (const patch of [
		{ taskId: "fake" },
		{ actorAgentId: "" },
		{ participantAgentIds: [] },
		{ outcome: "verified_result" },
		{ activityRevision: 2 },
		{ grantRevision: 0 },
		{ activityKind: "coding-only" },
	])
		expect(() =>
			parseResourceActivitySource({
				...source(),
				receipt: { ...source().receipt, ...patch },
			}),
		).toThrow();
	for (const fields of [
		null,
		{ ...source().fields, participantAgentIds: ["other"] },
		{ ...source().fields, outcome: "failed" },
	])
		expect(() =>
			parseResourceActivitySource({ ...source(), fields }),
		).toThrow();
});

test("work evidence v2 preserves distinct task and resource origins without changing v1", () => {
	const task = workInput("world").source;
	const legacy = {
		version: 1,
		worldId: "world",
		revision: 1,
		permissionRevision: 1,
		workConfigDigest: lifeDigest(null),
		records: [{ inputId: task.deliveryId, source: task }],
	};
	expect(parseWorkEvidence(legacy)).toMatchObject(legacy);
	const mixed = {
		...legacy,
		version: 2,
		records: [
			{ origin: "codex-task", inputId: task.deliveryId, source: task },
			{ origin: "resource-activity", inputId: "delivery", source: source() },
		],
	};
	expect(parseWorkEvidence(mixed)).toMatchObject(mixed);
	expect(() =>
		parseWorkEvidence({ ...legacy, records: mixed.records }),
	).toThrow();
	expect(() =>
		parseWorkEvidenceV2({
			...mixed,
			records: [{ ...mixed.records[0], origin: "resource-activity" }],
		}),
	).toThrow();
});
