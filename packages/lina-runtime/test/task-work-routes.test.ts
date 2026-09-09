import { expect, test } from "bun:test";
import { taskRoutes } from "../src/fleet/task-routes.ts";
import { required, workBridgeFixture } from "./helpers/work-bridge.ts";

test("protected task work route confirms actual owner evidence and exposes receipt/sharing/history", async () => {
	const f = await workBridgeFixture();
	try {
		const body = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 1,
			requestId: "confirm",
			evidenceRef: "private-verifier-reference",
		};
		const request = (suffix: string, method = "GET") =>
			new Request(`http://127.0.0.1/api/tasks/${f.task.id}/work${suffix}`, {
				method,
				headers: { host: "127.0.0.1", "content-type": "application/json" },
			});
		const confirmed = await taskRoutes(
			request("/confirm", "POST"),
			f.tasks,
			(id) => id === "lina",
			async () => body,
		);
		expect(confirmed?.status).toBe(200);
		expect(await confirmed?.json()).toMatchObject({
			receipt: { outcome: "verified_result", receiptRevision: 2 },
		});
		const read = required(
			await taskRoutes(
				request(""),
				f.tasks,
				() => true,
				async () => ({}),
			),
		);
		expect(await read.json()).toMatchObject({
			receipts: [{ receiptRevision: 1 }, { receiptRevision: 2 }],
			sharing: [{ selection: null }],
			deliveries: [],
		});
	} finally {
		await f.close();
	}
});

test("work authority cannot be forged and unknown current owners map to403", async () => {
	const f = await workBridgeFixture();
	try {
		const request = () =>
			new Request(`http://127.0.0.1/api/tasks/${f.task.id}/work/confirm`, {
				method: "POST",
				headers: { host: "127.0.0.1", "content-type": "application/json" },
			});
		const body = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 1,
			requestId: "confirm",
			evidenceRef: "evidence",
		};
		expect(
			(
				await taskRoutes(
					request(),
					f.tasks,
					() => true,
					async () => ({
						...body,
						authority: { actorId: "admin", ownerAgentId: "lina" },
					}),
				)
			)?.status,
		).toBe(400);
		expect(
			(
				await taskRoutes(
					request(),
					f.tasks,
					() => false,
					async () => body,
				)
			)?.status,
		).toBe(403);
		expect(f.tasks.workReceipts(f.task.id)).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("receipt and retry cannot cross task owners; management uses the actual current owner after handover", async () => {
	const f = await workBridgeFixture();
	try {
		await f.share();
		const delivery = required(f.tasks.pendingWorkDeliveries()[0]);
		const other = await f.tasks.create({
			ownerAgentId: "mira",
			title: "Other task",
			cwd: f.task.cwd,
			prompt: "Other private prompt",
			requestId: "other-task",
		});
		const request = (id: string, action: string) =>
			new Request(`http://127.0.0.1/api/tasks/${id}/work/${action}`, {
				method: "POST",
				headers: { host: "127.0.0.1", "content-type": "application/json" },
			});
		const body = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 1,
			requestId: "confirm",
			evidenceRef: "evidence",
		};
		expect(
			(
				await taskRoutes(
					request(other.id, "confirm"),
					f.tasks,
					() => true,
					async () => body,
				)
			)?.status,
		).toBe(400);
		expect(
			(
				await taskRoutes(
					request(other.id, "retry"),
					f.tasks,
					() => true,
					async () => ({
						deliveryId: delivery.deliveryId,
						payloadDigest: delivery.payloadDigest,
					}),
				)
			)?.status,
		).toBe(403);
		const task = required(f.tasks.list().find((t) => t.id === f.task.id));
		await f.tasks.handover(task.id, {
			ownerAgentId: "mira",
			expectedRevision: task.revision,
		});
		expect(
			(
				await taskRoutes(
					request(task.id, "confirm"),
					f.tasks,
					(id) => id === "mira",
					async () => body,
				)
			)?.status,
		).toBe(200);
		expect(f.tasks.workReceipts(task.id).at(-1)).toMatchObject({
			outcome: "verified_result",
			ownerAgentId: "lina",
			participantAgentIds: ["lina"],
		});
	} finally {
		await f.close();
	}
});

test("a queued owner change cannot use a previously resolved management capability", async () => {
	const f = await workBridgeFixture();
	try {
		const original = f.tasks.confirmWork.bind(f.tasks);
		f.tasks.confirmWork = async (id, input, authority) => {
			const task = required(f.tasks.list().find((t) => t.id === id));
			await f.tasks.handover(id, {
				ownerAgentId: "mira",
				expectedRevision: task.revision,
			});
			return original(id, input, authority);
		};
		const response = await taskRoutes(
			new Request(`http://127.0.0.1/api/tasks/${f.task.id}/work/confirm`, {
				method: "POST",
				headers: { host: "127.0.0.1", "content-type": "application/json" },
			}),
			f.tasks,
			() => true,
			async () => ({
				receiptId: f.receipt.id,
				expectedReceiptRevision: 1,
				requestId: "confirm",
				evidenceRef: "evidence",
			}),
		);
		expect(response?.status).toBe(403);
		expect(f.tasks.workReceipts(f.task.id)).toHaveLength(1);
	} finally {
		await f.close();
	}
});
