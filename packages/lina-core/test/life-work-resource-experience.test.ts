import { expect, test } from "bun:test";
import { parseLifeConfigInput } from "../src/world/authoring-request-validation.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import { stepWorkAncestry } from "../src/world/work-ancestry.ts";
import {
	applyWorkExperiences,
	workExperiences,
} from "../src/world/work-experience.ts";
import { workExperienceId } from "../src/world/work-selection.ts";
import type { ResourceActivityReceipt } from "../src/world/work-types.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput } from "./life-work-fixture.ts";

function frozenModels(f: ReturnType<typeof autonomyStoreFixture>) {
	const resolve = (lane: "director" | "actor") => {
		const configured = f.source.config.models?.[lane];
		if (!configured) return null;
		const exact = {
			profileId: `world-${lane}`,
			...configured,
			reasoning: "off" as const,
			maxOutputTokens: null,
			settingsRevision: 1,
		};
		return { ...exact, routeFingerprint: lifeDigest(exact) };
	};
	return { director: resolve("director"), actor: resolve("actor") };
}

function configureWork(f: ReturnType<typeof autonomyStoreFixture>) {
	const { worldId, revision, ...config } = f.store.lifeConfig(
		f.request.worldId,
	);
	f.store.setLifeConfig(
		worldId,
		revision,
		parseLifeConfigInput({
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "work",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		}),
	);
	f.request.expectedConfigRevision++;
	return worldId;
}

function resourceSource(
	worldId: string,
	options: {
		deliveryId?: string;
		operation?: "upsert" | "restrict";
		policyRevision?: number;
		receipt?: Partial<ResourceActivityReceipt>;
		fields?: {
			categoryId: string;
			outcome: "recorded" | "verified_result" | "failed" | null;
			participantAgentIds: string[] | null;
			summary: string | null;
		} | null;
	} = {},
) {
	const source = {
		kind: "resource_activity" as const,
		version: 1 as const,
		deliveryId: options.deliveryId ?? "resource-delivery",
		operation: options.operation ?? "upsert",
		sourceDigest: lifeDigest("actual source"),
		policyRevision: options.policyRevision ?? 1,
		receipt: {
			activityId: "activity",
			activityRevision: 1,
			supersedesRevision: null,
			resourceId: "resource",
			resourceRevision: 1,
			versionId: "version",
			memoryId: null,
			actorAgentId: "lina",
			participantAgentIds: ["lina"],
			activityKind: "search" as const,
			outcome: "recorded" as const,
			evidenceDigest: lifeDigest([]),
			grantId: "grant",
			grantRevision: 1,
			correction: null,
			...options.receipt,
		},
		fields:
			options.fields === undefined
				? {
						categoryId: "research",
						outcome: "recorded" as const,
						participantAgentIds: ["lina"],
						summary: "Searched reference",
					}
				: options.fields,
	};
	const input = parseLifeInput({
		version: 4,
		worldId,
		id: source.deliveryId,
		sourceRevision: source.receipt.activityRevision,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	});
	if (input.version !== 4) throw Error("expected resource activity input");
	return input;
}

function finishStep(f: ReturnType<typeof autonomyStoreFixture>, key: string) {
	const prepared = f.store.prepareLifeStep(
		{
			...f.request,
			idempotencyKey: key,
			resolvedModels: frozenModels(f),
		},
		() => 1,
	);
	expect(prepared.version).toBe(4);
	f.store.prepareLifeObservations(prepared.lease, prepared.id, null, f.clock());
	return f.store.finishLifeStep(prepared.lease, prepared.id, f.clock());
}

test("step v1 stays empty and colliding task/resource ids keep distinct experiences", () => {
	const f = autonomyStoreFixture();
	try {
		const worldId = configureWork(f);
		const task = workInput(worldId);
		const colliding = resourceSource(worldId, {
			deliveryId: "colliding-delivery",
			receipt: { activityId: task.source.receipt.receiptId },
		});
		f.store.admitWorkInput(task);
		f.store.admitWorkInput(colliding);
		const v4 = finishStep(f, "tick-v4");
		const v1 = { ...v4, version: 1 as const };
		expect(workExperiences(v1)).toEqual([]);
		expect(stepWorkAncestry(v1)).toEqual([]);
		const observations = workExperiences(v4);
		expect(observations).toHaveLength(2);
		expect(new Set(observations.map((item) => item.experienceId)).size).toBe(2);
		const resourceObservation = observations.find(
			(item) => item.record.source.kind === "resource_activity",
		);
		const taskObservation = observations.find(
			(item) => item.record.source.kind === "work",
		);
		if (!resourceObservation || !taskObservation)
			throw Error("missing origin observations");
		expect(
			workExperienceId(worldId, resourceObservation.record, "lina"),
		).not.toBe(workExperienceId(worldId, taskObservation.record, "lina"));
	} finally {
		f.close();
	}
});

test("resource activity input becomes a step4 experience, then replay and retract consume without duplicating", () => {
	const f = autonomyStoreFixture();
	try {
		const worldId = configureWork(f);
		const input = resourceSource(worldId);
		f.store.admitWorkInput(input);
		const first = finishStep(f, "tick-one");
		const observations = workExperiences(first);
		expect(observations).toHaveLength(1);
		const observation = observations[0];
		if (!observation) throw Error("missing observation");
		expect(observation.record.source.kind).toBe("resource_activity");
		expect(observation.text).toBe("Searched reference");
		expect(first.outcome?.commit.experiences.map((e) => e.id)).toEqual([
			observation.experienceId,
		]);
		expect(first.outcome?.commit.consumedInputIds).toContain(input.id);
		const ancestry = stepWorkAncestry(first);
		expect(
			ancestry.some(
				(row) =>
					row.subject.kind === "experience" &&
					row.refs.some(
						(ref) =>
							"origin" in ref &&
							ref.origin === "resource-activity" &&
							ref.inputId === input.id,
					),
			),
		).toBe(true);
		f.store.acceptLifeStep(
			first.lease,
			first.id,
			{ identity: f.source.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		const replay = finishStep(f, "tick-two");
		expect(workExperiences(replay)).toEqual([]);
		expect(replay.outcome?.commit.experiences).toEqual([]);
		const retract = resourceSource(worldId, {
			deliveryId: "resource-restrict",
			operation: "restrict",
			policyRevision: 2,
			fields: null,
			receipt: {
				activityRevision: 2,
				supersedesRevision: 1,
				grantRevision: 2,
				correction: { kind: "retract", reason: "share withdrawn" },
			},
		});
		f.store.admitWorkInput(retract);
		const retracted = finishStep(f, "tick-three");
		const retraction = workExperiences(retracted);
		expect(retraction).toHaveLength(1);
		const retractedObservation = retraction[0];
		if (!retractedObservation) throw Error("missing retraction");
		expect(retractedObservation.record.source.operation).toBe("restrict");
		expect(retractedObservation.text).toBe(
			"Previously shared resource activity evidence was retracted.",
		);
		expect(retracted.outcome?.commit.consumedInputIds).toContain(retract.id);
		expect(retractedObservation.experienceId).not.toBe(
			observation.experienceId,
		);
	} finally {
		f.close();
	}
});

test("recorded resource activity is not treated as a verified work success", () => {
	const f = autonomyStoreFixture();
	try {
		const worldId = configureWork(f);
		f.store.admitWorkInput(resourceSource(worldId));
		const step = finishStep(f, "tick-recorded");
		const [observation] = workExperiences(step);
		expect(observation?.record.source.fields?.outcome).toBe("recorded");
		expect(observation?.text).not.toMatch(/verified|success/i);
		const commit = structuredClone(step.outcome?.commit);
		if (!commit || commit.version !== 3) throw Error("missing commit");
		const before = commit.experiences.length;
		applyWorkExperiences(step, commit);
		expect(commit.experiences).toHaveLength(before);
	} finally {
		f.close();
	}
});

test("ancestry parser preserves origin-qualified references with equal input ids", async () => {
	const { parseWorkAncestry } = await import("../src/world/work-ancestry.ts");
	const base = {
		version: 2,
		inputId: "same",
		sourceDigest: lifeDigest("source"),
		workConfigDigest: lifeDigest("config"),
		operation: "upsert",
	};
	const rows = [
		{
			subject: { kind: "life_claim", id: "claim" },
			lifeRevision: 1,
			refs: [
				{ ...base, origin: "codex-task" },
				{ ...base, origin: "resource-activity" },
			],
		},
	];
	expect(parseWorkAncestry(rows)[0]?.refs).toHaveLength(2);
	expect(() =>
		parseWorkAncestry([
			{
				...rows[0],
				refs: [
					{ ...base, origin: "codex-task" },
					{ ...base, origin: "codex-task" },
				],
			},
		]),
	).toThrow(/Duplicate/);
});
