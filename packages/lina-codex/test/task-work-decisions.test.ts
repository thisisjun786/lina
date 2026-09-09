import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.ts";
import {
	createWorkManagementAuthority,
	createWorkVerifierAuthority,
} from "../src/task-work-authority.ts";
import type { WorkAuthority } from "../src/task-work-types.ts";
import { workExperienceKey, workProof } from "../src/task-work-validation.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";
import { createWork, required, workFixture } from "./task-work-fixture.ts";

const authority = createWorkManagementAuthority("local-ui", "kai");
const selection = {
	worldIds: ["world-1"],
	categoryId: "user-category",
	shareOutcome: true,
	shareParticipants: false,
	summary: null,
};
async function ready(
	status: "completed" | "failed" | "interrupted" = "completed",
) {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	const task = await createWork(manager, f.cwd);
	rpc.completeTurn(required(task.threadId), status);
	await manager.read(task.id);
	return {
		f,
		rpc,
		manager,
		task,
		receipt: required(manager.workReceipts(task.id)[0]),
	};
}
test("confirm, amend, retract and re-confirm are immutable causal revisions; payload and authority replay conflicts reject", async () => {
	const { f, manager, task, receipt } = await ready();
	try {
		const request = {
			receiptId: receipt.id,
			expectedReceiptRevision: 1,
			requestId: "confirmation",
			evidenceRef: "operator checked artifact",
		};
		const confirmed = await manager.confirmWork(task.id, request, authority);
		expect(confirmed).toMatchObject({
			outcome: "verified_result",
			receiptRevision: 2,
			supersedesRevision: 1,
			ownerAgentId: "kai",
			taskRevision: receipt.taskRevision,
		});
		expect(await manager.confirmWork(task.id, request, authority)).toEqual(
			confirmed,
		);
		await expect(
			manager.confirmWork(
				task.id,
				{ ...request, evidenceRef: "changed" },
				authority,
			),
		).rejects.toThrow(/conflict/);
		await expect(
			manager.confirmWork(
				task.id,
				request,
				createWorkManagementAuthority("other-actor", "kai"),
			),
		).rejects.toThrow(/conflict/);
		await expect(
			manager.confirmWork(
				task.id,
				{ ...request, requestId: "stale" },
				authority,
			),
		).rejects.toThrow(/revision/);
		const amended = await manager.correctWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedReceiptRevision: 2,
				requestId: "amend",
				kind: "amend",
				reason: "remove verification",
			},
			authority,
		);
		expect(amended).toMatchObject({
			outcome: "turn_ended",
			receiptRevision: 3,
			supersedesRevision: 2,
			evidenceRefs: [],
			correction: { kind: "amend", reason: "remove verification" },
		});
		const retracted = await manager.correctWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedReceiptRevision: 3,
				requestId: "retract",
				kind: "retract",
				reason: "withdraw",
			},
			authority,
		);
		expect(retracted.receiptRevision).toBe(4);
		const again = await manager.confirmWork(
			task.id,
			{ ...request, expectedReceiptRevision: 4, requestId: "reconfirm" },
			authority,
		);
		expect(again).toMatchObject({
			outcome: "verified_result",
			receiptRevision: 5,
			supersedesRevision: 4,
			correction: null,
		});
		expect(manager.workReceipts(task.id)[0]).toEqual(receipt);
	} finally {
		await manager.close();
		f.close();
	}
});
test("JSON authority, wrong owner, verifier forging and replacement outcomes are rejected", async () => {
	const { f, manager, task, receipt } = await ready("failed");
	try {
		const input = {
			receiptId: receipt.id,
			expectedReceiptRevision: 1,
			requestId: "claim",
			evidenceRef: "tests passed",
		};
		await expect(
			manager.confirmWork(task.id, input, {} as WorkAuthority),
		).rejects.toThrow(/authority/);
		await expect(
			manager.confirmWork(
				task.id,
				input,
				createWorkManagementAuthority("local-ui", "other"),
			),
		).rejects.toThrow(/own/);
		await expect(
			manager.confirmWork(task.id, input, authority),
		).rejects.toThrow(/completed/);
		await expect(
			manager.confirmWork(
				task.id,
				input,
				createWorkVerifierAuthority("verifier", () => true),
			),
		).rejects.toThrow(/completed/);
		await expect(
			manager.correctWork(
				task.id,
				{
					receiptId: receipt.id,
					expectedReceiptRevision: 1,
					requestId: "forgery",
					kind: "amend",
					reason: "claim",
					outcome: "verified_result",
				} as never,
				authority,
			),
		).rejects.toThrow(/fields/);
		expect(manager.workReceipts(task.id)).toEqual([receipt]);
	} finally {
		await manager.close();
		f.close();
	}
});
test("durable source retry, withholding, re-share and revocation keep delivery and experience identity separate", async () => {
	const { f, rpc, task, receipt, manager: first } = await ready();
	let manager = first;
	try {
		const req = {
			receiptId: receipt.id,
			expectedPolicyRevision: 0,
			requestId: "share-1",
			selection,
		};
		const shared = await manager.shareWork(task.id, req, authority);
		expect(shared.policyRevision).toBe(1);
		expect(await manager.shareWork(task.id, req, authority)).toEqual(shared);
		const d = required(manager.pendingWorkDeliveries()[0]);
		expect(d.fields).toEqual({
			categoryId: "user-category",
			outcome: "turn_ended",
			participantAgentIds: null,
			summary: null,
		});
		expect(manager.workProofCurrent(workProof(d))).toBe(true);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		expect(manager.pendingWorkDeliveries()).toEqual([d]);
		manager.recordWorkDeliveryAttempt(
			d.deliveryId,
			d.payloadDigest,
			"failed",
			"world commit failed",
		);
		expect(() =>
			manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest),
		).toThrow(/failed/);
		manager.retryWorkDelivery(d.deliveryId, d.payloadDigest);
		manager.recordWorkDeliveryAttempt(
			d.deliveryId,
			d.payloadDigest,
			"withheld",
			"destination work disabled",
		);
		expect(() =>
			manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest),
		).toThrow(/withheld/);
		manager.retryWorkDelivery(d.deliveryId, d.payloadDigest);
		expect(() =>
			manager.acknowledgeWorkDelivery(d.deliveryId, "wrong-digest"),
		).toThrow(/conflict/);
		manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest);
		manager.acknowledgeWorkDelivery(d.deliveryId, d.payloadDigest);
		expect(manager.pendingWorkDeliveries()).toEqual([]);
		await manager.shareWork(
			task.id,
			{
				...req,
				expectedPolicyRevision: 1,
				requestId: "revoke",
				selection: null,
			},
			authority,
		);
		const restricted = required(manager.pendingWorkDeliveries()[0]);
		expect(restricted).toMatchObject({
			operation: "restrict",
			worldId: "world-1",
			fields: null,
			policyRevision: 2,
		});
		expect(manager.workProofCurrent(workProof(d))).toBe(false);
		manager.acknowledgeWorkDelivery(
			restricted.deliveryId,
			restricted.payloadDigest,
		);
		await manager.shareWork(
			task.id,
			{ ...req, expectedPolicyRevision: 2, requestId: "reshare" },
			authority,
		);
		const again = required(manager.pendingWorkDeliveries()[0]);
		expect(again.deliveryId).not.toBe(d.deliveryId);
		expect(
			workExperienceKey(
				again.receipt.id,
				again.receipt.receiptRevision,
				again.worldId,
				"kai",
			),
		).toBe(
			workExperienceKey(
				d.receipt.id,
				d.receipt.receiptRevision,
				d.worldId,
				"kai",
			),
		);
		await manager.shareWork(
			task.id,
			{
				...req,
				expectedPolicyRevision: 3,
				requestId: "retarget",
				selection: { ...selection, worldIds: ["world-2"] },
			},
			authority,
		);
		expect(
			manager.pendingWorkDeliveries().map((d) => [d.worldId, d.operation]),
		).toEqual([
			["world-1", "restrict"],
			["world-2", "upsert"],
		]);
		expect(
			manager.workDeliveryAttempts(d.deliveryId).map((a) => a.status),
		).toEqual(["failed", "pending", "withheld", "pending", "delivered"]);
	} finally {
		await manager.close();
		f.close();
	}
});

test("failed source operations remain in startup drain until an explicit retry or policy change", async () => {
	const { f, rpc, task, receipt, manager: first } = await ready();
	let manager = first;
	try {
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
		const d = required(manager.pendingWorkDeliveries()[0]);
		manager.recordWorkDeliveryAttempt(
			d.deliveryId,
			d.payloadDigest,
			"failed",
			"destination unavailable",
		);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		expect(manager.pendingWorkDeliveries().map((d) => d.status)).toEqual([
			"failed",
		]);
	} finally {
		await manager.close();
		f.close();
	}
});

test("corrupted operation digest cannot silently survive reopen", async () => {
	const { f, task, receipt, manager } = await ready();
	try {
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
		await manager.close();
		const db = new DatabaseSync(f.path);
		db.prepare("UPDATE task_work_operations SET digest=?").run("0".repeat(64));
		db.close();
		expect(() => new TaskStore(f.path)).toThrow(/digest/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("existing managed request ID grammar remains reopen-compatible", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		await manager.create({
			ownerAgentId: "kai",
			title: "title",
			cwd: f.cwd,
			prompt: "text",
			requestId: "request with spaces",
		});
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		expect(manager.list()).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});

test("receipt revisions require their durable management decision on reopen", async () => {
	const { f, task, receipt, manager } = await ready();
	try {
		await manager.confirmWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedReceiptRevision: 1,
				requestId: "confirm",
				evidenceRef: "checked",
			},
			authority,
		);
		await manager.close();
		const db = new DatabaseSync(f.path);
		db.exec("DELETE FROM task_work_operations");
		db.close();
		expect(() => new TaskStore(f.path)).toThrow(/decision/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("persisted correction must agree with its original operation payload", async () => {
	const { f, task, receipt, manager } = await ready();
	try {
		const correction = await manager.correctWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedReceiptRevision: 1,
				requestId: "correct",
				kind: "amend",
				reason: "original reason",
			},
			authority,
		);
		await manager.close();
		const db = new DatabaseSync(f.path);
		const altered = {
			...correction,
			correction: { kind: "retract", reason: "altered reason" },
		};
		db.prepare(
			"UPDATE task_work_receipts SET receipt_json=? WHERE receipt_revision=2",
		).run(JSON.stringify(altered));
		db.prepare("UPDATE task_work_operations SET result_json=?").run(
			JSON.stringify(altered),
		);
		db.close();
		expect(() => new TaskStore(f.path)).toThrow(/decision/);
	} finally {
		await manager.close();
		f.close();
	}
});
