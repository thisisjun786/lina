import { expect, test } from "bun:test";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { required, workBridgeFixture } from "./helpers/work-bridge.ts";

test("unshared work stays private; unknown native attribution never inherits the current task owner", async () => {
	const f = await workBridgeFixture();
	try {
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		bridge.start();
		expect(f.world.store.lifeInputs(f.worldId)).toEqual([]);
		f.rpc.addExternalMessage(
			required(f.task.threadId),
			"mentions lina but proves no participation",
		);
		await f.tasks.read(f.task.id);
		const receipt = required(
			f.tasks
				.workReceipts(f.task.id)
				.find((r) => r.attributionStatus === "unknown"),
		);
		await f.tasks.shareWork(
			f.task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 0,
				requestId: "share-unknown",
				selection: { ...f.selection, shareParticipants: true },
			},
			f.authority,
		);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source,
		).toMatchObject({
			receipt: {
				ownerAgentId: null,
				participantAgentIds: [],
				attributionStatus: "unknown",
			},
			fields: { participantAgentIds: [] },
		});
		bridge.close();
		await f.share();
		expect(f.tasks.pendingWorkDeliveries()).toHaveLength(1);
		expect(f.world.store.lifeInputs(f.worldId)).toHaveLength(1);
		expect(() => bridge.poll()).toThrow("closed");
	} finally {
		await f.close();
	}
});

test("source reopen drains actual native receipt into world before ack, without private task content", async () => {
	const f = await workBridgeFixture();
	try {
		await f.share();
		await f.reopenSource();
		const errors: unknown[] = [];
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: (error) => errors.push(error),
		});
		bridge.start();
		const evidence = f.world.store.workEvidence(f.worldId);
		expect(evidence.records).toHaveLength(1);
		expect(evidence.records[0]?.source.fields).toEqual({
			categoryId: "research",
			outcome: "turn_ended",
			participantAgentIds: null,
			summary: null,
		});
		expect(evidence.records[0]?.source.receipt.ownerAgentId).toBe("lina");
		expect(f.tasks.pendingWorkDeliveries()).toEqual([]);
		const serialized = JSON.stringify(f.world.store.lifeInputs(f.worldId));
		expect(serialized).not.toContain("Private task");
		expect(serialized).not.toContain("evidenceRefs");
		expect(serialized).not.toContain("cwd");
		bridge.poll();
		expect(f.world.store.workEvidence(f.worldId)).toEqual(evidence);
		expect(errors).toEqual([]);
		bridge.close();
	} finally {
		await f.close();
	}
});

test("disabled and unconfigured work withhold upserts until explicit retry", async () => {
	const f = await workBridgeFixture(false);
	try {
		await f.share();
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		bridge.start();
		const delivery = required(f.tasks.pendingWorkDeliveries()[0]);
		expect(delivery.status).toBe("withheld");
		expect(f.world.store.lifeInputs(f.worldId)).toEqual([]);
		f.configure(f.work);
		bridge.poll();
		expect(f.world.store.lifeInputs(f.worldId)).toEqual([]);
		f.tasks.retryWorkDelivery(delivery.deliveryId, delivery.payloadDigest);
		expect(f.tasks.pendingWorkDeliveries()).toEqual([]);
		expect(f.world.store.lifeInputs(f.worldId)).toHaveLength(1);
		bridge.close();
	} finally {
		await f.close();
	}
});

test("restrictions deliver after work null and target removal even though upsert proof is ineligible", async () => {
	const f = await workBridgeFixture();
	try {
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		bridge.start();
		await f.share();
		f.configure(null);
		await f.share(null);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source.operation,
		).toBe("restrict");
		expect(f.tasks.pendingWorkDeliveries()).toEqual([]);
		expect(f.world.store.lifeInputs(f.worldId)).toHaveLength(2);
		bridge.close();
	} finally {
		await f.close();
	}
});
