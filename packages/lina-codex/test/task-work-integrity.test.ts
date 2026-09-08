import { expect, spyOn, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
	createWorkManagementAuthority,
	createWorkVerifierAuthority,
} from "../src/task-work-authority.ts";
import type { ShareWorkInput } from "../src/task-work-types.ts";
import { workProof } from "../src/task-work-validation.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";
import { createWork, required, workFixture } from "./task-work-fixture.ts";

const authority = createWorkManagementAuthority("operator", "kai");
const selection = {
	worldIds: ["world-a", "world-b"],
	categoryId: "chosen",
	shareOutcome: true,
	shareParticipants: true,
	summary: "explicit user summary",
};

test("managed handover/input participants are original and immutable; latest owner cannot rewrite them", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		const handed = await manager.handover(task.id, {
			ownerAgentId: "nina",
			expectedRevision: task.revision,
		});
		await manager.message(task.id, {
			text: "mentions forged-agent",
			requestId: "steer",
			expectedRevision: handed.revision,
		});
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const baseline = required(manager.workReceipts(task.id)[0]);
		expect(baseline).toMatchObject({
			ownerAgentId: "kai",
			participantAgentIds: ["kai", "nina"],
		});
		const req = {
			receiptId: baseline.id,
			expectedReceiptRevision: 1,
			requestId: "confirm",
			evidenceRef: "checked",
		};
		await expect(manager.confirmWork(task.id, req, authority)).rejects.toThrow(
			/own/,
		);
		const confirmed = await manager.confirmWork(
			task.id,
			req,
			createWorkManagementAuthority("operator", "nina"),
		);
		expect(confirmed).toMatchObject({
			ownerAgentId: "kai",
			participantAgentIds: ["kai", "nina"],
			outcome: "verified_result",
		});
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		expect(manager.workReceipts(task.id)).toEqual([baseline, confirmed]);
	} finally {
		await manager.close();
		f.close();
	}
});

test("registered verifier validates exact observed receipt and cannot grant sharing or replace interrupted status", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const baseline = required(manager.workReceipts(task.id)[0]);
		const req = {
			receiptId: baseline.id,
			expectedReceiptRevision: 1,
			requestId: "verify",
			evidenceRef: "artifact-sha256",
		};
		await expect(
			manager.confirmWork(
				task.id,
				req,
				createWorkVerifierAuthority("registered", () => false),
			),
		).rejects.toThrow(/authorize/);
		const verifier = createWorkVerifierAuthority(
			"registered",
			(ctx) =>
				ctx.receipt.id === baseline.id &&
				ctx.receipt.outcome === "turn_ended" &&
				ctx.receipt.receiptRevision === 1 &&
				ctx.taskId === task.id &&
				ctx.evidenceRef === "artifact-sha256",
		);
		const verified = await manager.confirmWork(task.id, req, verifier);
		expect(verified.evidenceRefs).toEqual([
			{
				kind: "verifier",
				authorityId: "registered",
				reference: "artifact-sha256",
				receiptRevision: 1,
			},
		]);
		await expect(
			manager.shareWork(
				task.id,
				{
					receiptId: baseline.id,
					expectedPolicyRevision: 0,
					requestId: "share",
					selection,
				},
				verifier,
			),
		).rejects.toThrow(/authorize/);
		const read = await manager.read(task.id);
		await manager.message(task.id, {
			text: "next",
			requestId: "next",
			expectedRevision: read.task.revision,
		});
		rpc.completeTurn(required(task.threadId), "interrupted");
		await manager.read(task.id);
		const interrupted = required(manager.workReceipts(task.id).at(-1));
		expect(interrupted.outcome).toBe("interrupted");
		await expect(
			manager.confirmWork(
				task.id,
				{ ...req, receiptId: interrupted.id, requestId: "false-success" },
				authority,
			),
		).rejects.toThrow(/completed/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("strict sharing requests never infer fields, targets or authority; replay/revision negatives leave policy unchanged", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const receipt = required(manager.workReceipts(task.id)[0]);
		const req = {
			receiptId: receipt.id,
			expectedPolicyRevision: 0,
			requestId: "share",
			selection,
		};
		const malformed: unknown[] = [
			{ ...req, expectedPolicyRevision: -1 },
			{ ...req, expectedPolicyRevision: 1.5 },
			{ ...req, requestId: "x".repeat(129) },
			{ ...req, ownerAgentId: "kai" },
			{ ...req, selection: { ...selection, worldIds: [] } },
			{ ...req, selection: { ...selection, worldIds: ["world-a", "world-a"] } },
			{ ...req, selection: { ...selection, shareOutcome: undefined } },
			{ ...req, selection: { ...selection, categoryId: "" } },
			{ ...req, selection: { ...selection, summary: "x".repeat(2049) } },
			{ ...req, selection: { ...selection, authority: "user" } },
		];
		for (const value of malformed)
			await expect(
				manager.shareWork(task.id, value as ShareWorkInput, authority),
			).rejects.toThrow();
		expect(manager.workSharing(task.id, receipt.id)).toMatchObject({
			policyRevision: 0,
			selection: null,
		});
		expect(manager.pendingWorkDeliveries()).toEqual([]);
		await manager.shareWork(task.id, req, authority);
		await expect(
			manager.shareWork(task.id, { ...req, selection: null }, authority),
		).rejects.toThrow(/conflict/);
		await expect(
			manager.shareWork(task.id, { ...req, requestId: "stale" }, authority),
		).rejects.toThrow(/revision/);
		expect(manager.workSharing(task.id, receipt.id).policyRevision).toBe(1);
	} finally {
		await manager.close();
		f.close();
	}
});

test("source transaction failure rolls back terminal task state and receipt, then native reconnect observes it once", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	let hook: ReturnType<typeof spyOn> | undefined;
	try {
		const task = await createWork(manager, f.cwd);
		const original = DatabaseSync.prototype.prepare;
		hook = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
			function (this: DatabaseSync, sql: string) {
				if (sql === "INSERT INTO task_work_receipts VALUES (?,?,?)")
					throw new Error("synthetic receipt write crash");
				return original.call(this, sql);
			},
		);
		rpc.completeTurn(required(task.threadId));
		await expect(manager.read(task.id)).rejects.toThrow(/crash/);
		expect(manager.list()[0]?.status).toBe("running");
		expect(manager.workReceipts(task.id)).toEqual([]);
		hook.mockRestore();
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		expect(manager.workReceipts(task.id)).toHaveLength(1);
		expect(manager.workReceipts(task.id)[0]?.outcome).toBe("turn_ended");
		await manager.restore();
		expect(manager.workReceipts(task.id)).toHaveLength(1);
		expect(rpc.calls("turn/start")).toHaveLength(1);
	} finally {
		hook?.mockRestore();
		await manager.close();
		f.close();
	}
});

test("outbox crash rolls back sharing decision/request and emits no wake; retry key remains valid", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	let hook: ReturnType<typeof spyOn> | undefined;
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const receipt = required(manager.workReceipts(task.id)[0]);
		let wakes = 0;
		manager.subscribeWork(() => wakes++);
		const original = DatabaseSync.prototype.prepare;
		hook = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
			function (this: DatabaseSync, sql: string) {
				if (sql.startsWith("INSERT INTO task_work_deliveries"))
					throw new Error("synthetic outbox crash");
				return original.call(this, sql);
			},
		);
		const req = {
			receiptId: receipt.id,
			expectedPolicyRevision: 0,
			requestId: "share",
			selection,
		};
		await expect(manager.shareWork(task.id, req, authority)).rejects.toThrow(
			/crash/,
		);
		expect(manager.workSharing(task.id, receipt.id).policyRevision).toBe(0);
		expect(wakes).toBe(0);
		hook.mockRestore();
		await manager.shareWork(task.id, req, authority);
		expect(wakes).toBe(1);
		expect(manager.pendingWorkDeliveries()).toHaveLength(2);
	} finally {
		hook?.mockRestore();
		await manager.close();
		f.close();
	}
});

test("delivered receipt retraction and target removal reach every historical world after reopen", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const receipt = required(manager.workReceipts(task.id)[0]);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 0,
				requestId: "share",
				selection,
			},
			authority,
		);
		const deliveries = manager.pendingWorkDeliveries();
		for (const d of deliveries)
			manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest);
		await manager.correctWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedReceiptRevision: 1,
				requestId: "retract",
				kind: "retract",
				reason: "evidence withdrawn",
			},
			authority,
		);
		expect(
			deliveries.every((d) => !manager.workProofCurrent(workProof(d))),
		).toBe(true);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		const restrictions = manager.pendingWorkDeliveries();
		expect(
			restrictions.map((d) => [
				d.worldId,
				d.operation,
				d.receipt.receiptRevision,
			]),
		).toEqual([
			["world-a", "restrict", 2],
			["world-b", "restrict", 2],
		]);
		for (const d of restrictions)
			manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 1,
				requestId: "revoke-all",
				selection: null,
			},
			authority,
		);
		expect(manager.pendingWorkDeliveries().map((d) => d.worldId)).toEqual([
			"world-a",
			"world-b",
		]);
		expect(manager.workReceipts(task.id)[0]).toEqual(receipt);
	} finally {
		await manager.close();
		f.close();
	}
});

test("bridge validates restriction revisions independently from eligible work proof", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const receipt = required(manager.workReceipts(task.id)[0]);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 0,
				requestId: "share",
				selection,
			},
			authority,
		);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 1,
				requestId: "revoke",
				selection: null,
			},
			authority,
		);
		const restriction = required(manager.pendingWorkDeliveries()[0]);
		expect(manager.workProofCurrent(workProof(restriction))).toBe(false);
		expect(
			manager.workDeliveryCurrent(
				restriction.deliveryId,
				restriction.payloadDigest,
			),
		).toBe(true);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 2,
				requestId: "reshare",
				selection,
			},
			authority,
		);
		expect(
			manager.workDeliveryCurrent(
				restriction.deliveryId,
				restriction.payloadDigest,
			),
		).toBe(false);
		expect(() =>
			manager.acknowledgeWorkDelivery(
				restriction.deliveryId,
				restriction.payloadDigest,
			),
		).toThrow(/stale|withheld/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("explicit retry wakes delivery consumer once after commit", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		const receipt = required(manager.workReceipts(task.id)[0]);
		await manager.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 0,
				requestId: "share",
				selection,
			},
			authority,
		);
		const delivery = required(manager.pendingWorkDeliveries()[0]);
		manager.recordWorkDeliveryAttempt(
			delivery.deliveryId,
			delivery.payloadDigest,
			"failed",
			"temporary failure",
		);
		let wakes = 0;
		manager.subscribeWork(() => {
			wakes++;
			expect(
				manager
					.workDeliveries()
					.find((d) => d.deliveryId === delivery.deliveryId)?.status,
			).toBe("pending");
		});
		manager.retryWorkDelivery(delivery.deliveryId, delivery.payloadDigest);
		manager.retryWorkDelivery(delivery.deliveryId, delivery.payloadDigest);
		expect(wakes).toBe(1);
	} finally {
		await manager.close();
		f.close();
	}
});
