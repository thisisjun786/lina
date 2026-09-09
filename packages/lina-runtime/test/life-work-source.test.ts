import { expect, test } from "bun:test";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { assertWorkSourceCurrent } from "../src/life/work-source.ts";
import { workBridgeFixture } from "./helpers/work-bridge.ts";

test("failed restriction delivery cannot keep a frozen or retained work snapshot eligible", async () => {
	const f = await workBridgeFixture();
	const bridge = createWorkBridge({
		source: f.tasks,
		world: f.world.store,
		onError() {},
	});
	try {
		bridge.start();
		await f.share();
		const frozen = f.world.store.workEvidence(f.worldId);
		expect(() => assertWorkSourceCurrent(f.tasks, frozen)).not.toThrow();
		bridge.close();
		await f.share(null);
		const pending = f.tasks.pendingWorkDeliveries()[0];
		if (!pending) throw Error("Missing restriction");
		f.tasks.recordWorkDeliveryAttempt(
			pending.deliveryId,
			pending.payloadDigest,
			"failed",
			"destination_unavailable",
		);
		expect(f.world.store.workEvidence(f.worldId)).toEqual(frozen);
		expect(() => assertWorkSourceCurrent(f.tasks, frozen)).toThrow(
			"authority changed",
		);
		expect(() => assertWorkSourceCurrent(undefined, frozen)).toThrow(
			"authority changed",
		);
		const recover = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError() {},
		});
		recover.start();
		f.tasks.retryWorkDelivery(pending.deliveryId, pending.payloadDigest);
		const restricted = f.world.store.workEvidence(f.worldId);
		expect(restricted.records[0]?.source.operation).toBe("restrict");
		expect(() => assertWorkSourceCurrent(f.tasks, restricted)).not.toThrow();
		recover.close();
	} finally {
		bridge.close();
		await f.close();
	}
});

test("resource source guard consults its owner even when no task manager exists", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const { ResourceStore } = await import(
		"../../lina-memory/src/resources/store.ts"
	);
	const { ResourceActivities } = await import(
		"../../lina-memory/src/resources/activities.ts"
	);
	const { lifeDigest } = await import("../../lina-core/src/world/life-json.ts");
	const root = mkdtempSync(join(tmpdir(), "lina-resource-source-"));
	const resources = new ResourceStore(root, {
		maxFileBytes: 4096,
		maxCatalogBytes: 8192,
		maxExtractionBytes: 4096,
	});
	const activities = new ResourceActivities(root, resources, {
		isWorldParticipant: () => true,
	});
	const scope = {
		principalId: "agent:lina",
		agentId: "lina",
		allowedVisibilities: ["shared"] as "shared"[],
	};
	try {
		const doc = resources.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "Search",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("Research result"),
		});
		activities.create(scope, {
			operationId: "create",
			activityId: "activity",
			worldId: "world",
			actorAgentId: "lina",
			participantAgentIds: ["lina"],
			activityKind: "research",
			outcome: "recorded",
			resourceId: doc.id,
			versionId: null,
			memoryId: null,
			quotes: [],
			hostConfirmed: false,
			fields: {
				categoryId: "research",
				outcome: "recorded",
				participantAgentIds: ["lina"],
				summary: "Research recorded",
			},
			policyRevision: 1,
		});
		const source = activities.pending(scope, "world")[0]?.source;
		if (!source) throw Error("Missing source");
		const snapshot = {
			version: 2 as const,
			worldId: "world",
			revision: 1,
			permissionRevision: 1,
			workConfigDigest: lifeDigest(null),
			records: [
				{
					origin: "resource-activity" as const,
					inputId: source.deliveryId,
					source,
				},
			],
		};
		const authority = {
			current: (worldId: string, record: typeof source) =>
				activities.current(scope, worldId, record),
		};
		expect(() =>
			assertWorkSourceCurrent(undefined, snapshot, authority),
		).not.toThrow();
		expect(() => assertWorkSourceCurrent(undefined, snapshot)).toThrow();
		activities.ack(scope, {
			operationId: "ack",
			deliveryId: source.deliveryId,
			sourceDigest: source.sourceDigest,
		});
		expect(() =>
			assertWorkSourceCurrent(undefined, snapshot, authority),
		).not.toThrow();
		activities.restrict(scope, {
			operationId: "restrict",
			activityId: "activity",
			expectedRevision: 1,
			worldId: "world",
			policyRevision: 2,
		});
		expect(() =>
			assertWorkSourceCurrent(undefined, snapshot, authority),
		).toThrow(/authority changed/);
	} finally {
		activities.close();
		resources.close();
		rmSync(root, { recursive: true, force: true });
	}
});
