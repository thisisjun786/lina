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
	expect(
		parseWorkEvidence({ ...mixed, records: [...mixed.records].reverse() }),
	).toMatchObject(mixed);
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

test("taskless recorded activity contributes only through its receipt actor and shared fields", async () => {
	const { matchingWork, projectWorkObservations, workExperienceId } =
		await import("../src/world/work-selection.ts");
	const { autonomyStoreFixture } = await import(
		"./life-autonomy-store-fixture.ts"
	);
	const f = autonomyStoreFixture();
	try {
		const rule = {
			id: "recorded",
			familyId: "research",
			categoryId: "research",
			outcomes: ["recorded" as const],
			attribution: "owner" as const,
			weight: 2,
			requiredMatch: false,
		};
		const activity = parseResourceActivitySource(source());
		const work = parseWorkEvidence({
			version: 2,
			worldId: f.request.worldId,
			revision: 1,
			permissionRevision: 1,
			workConfigDigest: lifeDigest(null),
			records: [
				{
					origin: "resource-activity",
					inputId: activity.deliveryId,
					source: activity,
				},
			],
		});
		const configured = {
			work,
			config: {
				...f.source.config,
				version: 2 as const,
				work: { rules: [rule] },
			},
		};
		expect(matchingWork(configured, rule, "lina")).toHaveLength(1);
		expect(matchingWork(configured, rule, "other")).toEqual([]);
		expect(projectWorkObservations(configured, "lina")).toEqual([
			{
				categoryId: "research",
				outcome: "recorded",
				participantAgentIds: ["lina"],
				summary: "Searched source material",
				corrected: false,
			},
		]);
		const task = workInput(f.request.worldId).source;
		const sameId = {
			...task,
			receipt: { ...task.receipt, receiptId: activity.receipt.activityId },
		};
		expect(
			workExperienceId(
				f.request.worldId,
				{ inputId: "delivery", origin: "resource-activity", source: activity },
				"lina",
			),
		).not.toBe(
			workExperienceId(
				f.request.worldId,
				{ inputId: "task-delivery", source: sameId },
				"lina",
			),
		);
	} finally {
		f.close();
	}
});

test("work v2 ancestry binds origin so resource and task references cannot alias", async () => {
	const { workRef, workRefsCurrent, parseWorkAncestry } = await import(
		"../src/world/work-ancestry.ts"
	);
	const resource = parseResourceActivitySource(source());
	const snapshot = parseWorkEvidenceV2({
		version: 2,
		worldId: "world",
		revision: 1,
		permissionRevision: 1,
		workConfigDigest: lifeDigest(null),
		records: [
			{
				origin: "resource-activity",
				inputId: resource.deliveryId,
				source: resource,
			},
		],
	});
	const record = snapshot.records[0];
	if (!record) throw Error("missing record");
	const ref = workRef(snapshot, record);
	expect(ref).toMatchObject({
		version: 2,
		origin: "resource-activity",
		sourceDigest: lifeDigest({
			version: 2,
			origin: "resource-activity",
			source: resource,
		}),
	});
	expect(workRefsCurrent(snapshot, [ref])).toBe(true);
	const ancestry = [
		{ subject: { kind: "goal", id: "goal" }, lifeRevision: 1, refs: [ref] },
	];
	expect(parseWorkAncestry(ancestry)).toMatchObject(ancestry);
	expect(
		workRefsCurrent(snapshot, [{ ...ref, version: 2, origin: "codex-task" }]),
	).toBe(false);
});

test("LIFE v4 binds resource delivery identity, revision and digest without accepting it as a task", async () => {
	const { parseLifeInput } = await import("../src/world/life-validation.ts");
	const activity = parseResourceActivitySource(source());
	const input = {
		version: 4,
		worldId: "world",
		id: activity.deliveryId,
		sourceRevision: 1,
		payloadDigest: lifeDigest(activity),
		source: activity,
		consumedLifeRevision: null,
	};
	expect(parseLifeInput(input)).toMatchObject(input);
	for (const patch of [
		{ version: 2 },
		{ version: 1 },
		{ id: "other" },
		{ sourceRevision: 2 },
		{ payloadDigest: lifeDigest("wrong") },
	])
		expect(() => parseLifeInput({ ...input, ...patch })).toThrow();
});
