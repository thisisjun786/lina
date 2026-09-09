import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { autonomyStoreFixture } from "../../lina-core/test/life-autonomy-store-fixture.ts";
import { ResourceActivities } from "../../lina-memory/src/resources/activities.ts";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import {
	createResourceActivityBridge,
	ResourceActivityDeliveryError,
} from "../src/life/resource-bridge.ts";

test("resource delivery replays world admission after acknowledgement failure and propagates revocation", () => {
	const f = autonomyStoreFixture();
	const root = mkdtempSync(join(tmpdir(), "lina-resource-bridge-"));
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
	let world = f.store;
	try {
		const { worldId, revision, ...config } = world.lifeConfig(
			f.request.worldId,
		);
		world.setLifeConfig(worldId, revision, {
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "research",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		});
		const doc = resources.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "Research",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("Research text"),
		});
		activities.create(scope, {
			operationId: "create",
			activityId: "activity",
			worldId,
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
				summary: "Research result",
			},
			policyRevision: 1,
		});
		const broken = createResourceActivityBridge({
			source: {
				pending: activities.pending.bind(activities),
				current: activities.current.bind(activities),
				ack() {
					throw Error("ack interrupted");
				},
			},
			scope,
			world,
		});
		expect(failureOf(() => broken.poll(worldId))).toBeInstanceOf(
			ResourceActivityDeliveryError,
		);
		const snapshot = world.workEvidence(worldId);
		expect(snapshot.records).toHaveLength(1);
		world.close();
		world = new WorldStore(f.path, f.clock);
		const bridge = createResourceActivityBridge({
			source: activities,
			scope,
			world,
		});
		expect(bridge.poll(worldId)).toEqual({ delivered: 1, replayed: 1 });
		expect(world.workEvidence(worldId)).toEqual(snapshot);
		expect(activities.pending(scope, worldId)).toHaveLength(0);
		resources.update(scope, {
			operationId: "edit",
			id: doc.id,
			expectedRevision: doc.revision,
			bytes: new TextEncoder().encode("Changed"),
		});
		const {
			worldId: _id,
			revision: rev,
			...current
		} = world.lifeConfig(worldId);
		activities.create(scope, {
			operationId: "blocked-create",
			activityId: "a-blocked",
			worldId,
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
				summary: "Research result",
			},
			policyRevision: 1,
		});
		world.setLifeConfig(worldId, rev, { ...current, version: 2, work: null });
		expect(failureOf(() => bridge.poll(worldId))).toBeInstanceOf(
			ResourceActivityDeliveryError,
		);
		expect(world.workEvidence(worldId).records[0]?.source.operation).toBe(
			"restrict",
		);
		expect(failureOf(() => bridge.poll(worldId))).toBeInstanceOf(
			ResourceActivityDeliveryError,
		);
		expect(activities.pending(scope, worldId)).toHaveLength(1);
	} finally {
		world.close();
		activities.close();
		resources.close();
		f.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function failureOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw Error("Expected a delivery failure");
}
