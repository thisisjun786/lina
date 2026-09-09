import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { TaskStore } from "../../lina-codex/src/task-store.ts";
import { workProof } from "../../lina-codex/src/task-work-validation.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { autonomyPack } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { activateSocialPack } from "../../lina-core/test/life-social-store-fixture.ts";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { required, workBridgeFixture } from "./helpers/work-bridge.ts";

test("one disabled real world does not withhold another world's permitted delivery", async () => {
	const f = await workBridgeFixture();
	const disabled = new WorldStore(`${f.taskPath}.world`, f.world.clock);
	try {
		const pack = autonomyPack();
		pack.worldId = "a-disabled-world";
		pack.world.id = pack.worldId;
		pack.life.worldId = pack.worldId;
		activateSocialPack(disabled, pack);
		await f.share({ ...f.selection, worldIds: [pack.worldId, f.worldId] });
		const destination = (id: string) =>
			id === pack.worldId ? disabled : f.world.store;
		const bridge = createWorkBridge({
			source: f.tasks,
			world: {
				lifeConfig: (id) => destination(id).lifeConfig(id),
				workEvidence: (id) => destination(id).workEvidence(id),
				admitWorkInput: (input) =>
					destination(input.worldId).admitWorkInput(input),
			},
			onError: () => {},
		});
		expect(bridge.start()).toMatchObject({ delivered: 1, withheld: 1 });
		expect(f.world.store.lifeInputs(f.worldId)).toHaveLength(1);
		expect(disabled.lifeInputs(pack.worldId)).toEqual([]);
		bridge.close();
	} finally {
		disabled.close();
		await f.close();
	}
});

test("lost acknowledgement survives both DB reopens; explicit retry replays the same inbox once", async () => {
	const f = await workBridgeFixture();
	let reopened: WorldStore | undefined;
	try {
		await f.share();
		const delivery = required(f.tasks.pendingWorkDeliveries()[0]);
		const errors: unknown[] = [];
		f.tasks.acknowledgeWorkDelivery = () => {
			throw Error("synthetic lost ack");
		};
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: (error) => errors.push(error),
		});
		expect(bridge.start().failed).toBe(1);
		const snapshot = f.world.store.workEvidence(f.worldId);
		expect(snapshot.records).toHaveLength(1);
		expect(f.tasks.pendingWorkDeliveries()[0]?.status).toBe("failed");
		expect(bridge.poll().delivered).toBe(0);
		expect(errors).toHaveLength(1);
		bridge.close();
		f.world.store.close();
		reopened = new WorldStore(f.world.path, f.world.clock);
		await f.reopenSource();
		const restored = createWorkBridge({
			source: f.tasks,
			world: reopened,
			onError: (error) => errors.push(error),
		});
		expect(restored.start().delivered).toBe(0);
		f.tasks.retryWorkDelivery(delivery.deliveryId, delivery.payloadDigest);
		expect(f.tasks.pendingWorkDeliveries()).toEqual([]);
		expect(reopened.workEvidence(f.worldId)).toEqual(snapshot);
		expect(reopened.lifeInputs(f.worldId)).toHaveLength(1);
		expect(
			f.tasks.workDeliveryAttempts(delivery.deliveryId).map((a) => a.status),
		).toEqual(["failed", "pending", "delivered"]);
		expect(f.rpc.calls("turn/start")).toHaveLength(1);
		restored.close();
	} finally {
		reopened?.close();
		await f.close();
	}
});

test("unknown destination does not stop another world; retargeting keeps restriction delivery", async () => {
	const f = await workBridgeFixture();
	try {
		await f.share({ ...f.selection, worldIds: ["a-missing-world", f.worldId] });
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		expect(bridge.start()).toMatchObject({ delivered: 1, withheld: 1 });
		expect(f.tasks.pendingWorkDeliveries()).toMatchObject([
			{ worldId: "a-missing-world", status: "withheld" },
		]);
		f.configure(null);
		bridge.close();
		await f.share({ ...f.selection, worldIds: ["new-missing-world"] });
		const restriction = required(
			f.tasks.pendingWorkDeliveries().find((d) => d.worldId === f.worldId),
		);
		expect(restriction.operation).toBe("restrict");
		expect(
			f.tasks.workDeliveryCurrent(
				restriction.deliveryId,
				restriction.payloadDigest,
			),
		).toBe(true);
		expect(f.tasks.workProofCurrent(workProof(restriction))).toBe(false);
		const resumed = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		expect(resumed.start().delivered).toBe(1);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source.operation,
		).toBe("restrict");
		resumed.close();
	} finally {
		await f.close();
	}
});

test("confirmation evidence is hashed while only explicitly shared fields enter the work observation", async () => {
	const f = await workBridgeFixture();
	try {
		const confirmed = await f.tasks.confirmWork(
			f.task.id,
			{
				receiptId: f.receipt.id,
				expectedReceiptRevision: 1,
				requestId: "confirm",
				evidenceRef: "/private/verifier/raw-output",
			},
			f.authority,
		);
		await f.share({
			...f.selection,
			shareOutcome: false,
			shareParticipants: true,
			summary: "Explicitly shared summary",
		});
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: () => {},
		});
		bridge.start();
		const input = required(f.world.store.lifeInputs(f.worldId)[0]);
		expect(confirmed.evidenceRefs).toEqual([
			{
				authorityId: "local-task-management",
				kind: "owner_confirmation",
				receiptRevision: 1,
				reference: "/private/verifier/raw-output",
			},
		]);
		const expectedDigest = createHash("sha256")
			.update(
				'[{"authorityId":"local-task-management","kind":"owner_confirmation","receiptRevision":1,"reference":"/private/verifier/raw-output"}]',
			)
			.digest("hex");
		expect(input.source).toMatchObject({
			receipt: {
				outcome: "verified_result",
				evidenceDigest: expectedDigest,
			},
			fields: {
				outcome: null,
				participantAgentIds: ["lina"],
				summary: "Explicitly shared summary",
			},
		});
		expect(JSON.stringify(input)).not.toContain("/private/verifier");
		expect(JSON.stringify(input)).not.toContain("authorityId");
		bridge.close();
	} finally {
		await f.close();
	}
});

test("source permission changes before admission and before ack reject stale proof", async () => {
	for (const boundary of ["admission", "ack"] as const) {
		const f = await workBridgeFixture();
		let sourceStore: TaskStore | undefined;
		try {
			await f.share();
			const delivery = required(f.tasks.pendingWorkDeliveries()[0]);
			sourceStore = new TaskStore(f.taskPath);
			const store = sourceStore;
			let changed = false;
			function revoke() {
				if (changed) return;
				changed = true;
				store.shareWork(
					f.task.id,
					{
						receiptId: f.receipt.id,
						expectedPolicyRevision: 1,
						requestId: "race-revoke",
						selection: null,
					},
					f.authority,
				);
			}
			const bridge = createWorkBridge({
				source: f.tasks,
				world: {
					workEvidence: (id) => f.world.store.workEvidence(id),
					lifeConfig: (id) => {
						const value = f.world.store.lifeConfig(id);
						if (boundary === "admission") revoke();
						return value;
					},
					admitWorkInput: (input) => {
						const receipt = f.world.store.admitWorkInput(input);
						if (boundary === "ack") revoke();
						return receipt;
					},
				},
				onError: () => {},
			});
			bridge.start();
			expect(
				f.tasks
					.workDeliveries()
					.find((d) => d.deliveryId === delivery.deliveryId)?.status,
			).toBe("withheld");
			expect(f.world.store.lifeInputs(f.worldId)).toHaveLength(
				boundary === "admission" ? 0 : 1,
			);
			bridge.poll();
			expect(
				f.world.store.workEvidence(f.worldId).records[0]?.source.operation,
			).toBe("restrict");
			expect(f.tasks.pendingWorkDeliveries()).toEqual([]);
			bridge.close();
		} finally {
			sourceStore?.close();
			await f.close();
		}
	}
});

test("forged pending payload cannot reuse a genuine source digest", async () => {
	const f = await workBridgeFixture();
	try {
		await f.share();
		const pending = f.tasks.pendingWorkDeliveries.bind(f.tasks);
		f.tasks.pendingWorkDeliveries = () =>
			pending().map((d) => ({
				...d,
				fields: d.fields && {
					...d.fields,
					summary: "Injected private content",
				},
			}));
		const errors: unknown[] = [];
		const bridge = createWorkBridge({
			source: f.tasks,
			world: f.world.store,
			onError: (error) => errors.push(error),
		});
		expect(bridge.start().failed).toBe(1);
		expect(f.world.store.lifeInputs(f.worldId)).toEqual([]);
		expect(pending()[0]?.status).toBe("failed");
		expect(errors).toHaveLength(1);
		bridge.close();
	} finally {
		await f.close();
	}
});
