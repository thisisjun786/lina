import { describe, expect, test } from "bun:test";
import { TaskStore } from "../src/task-store.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";

import { createWork, required, workFixture } from "./task-work-fixture.ts";

describe("native work receipts", () => {
	test("actual native completion commits one observed receipt before notification, survives reopen and owner changes", async () => {
		const f = workFixture();
		const rpc = new FakeCodexRpc();
		let manager = new TaskManager({ path: f.path, rpc });
		try {
			const task = await createWork(manager, f.cwd);
			expect(manager.workReceipts(task.id)).toEqual([]);
			const changed = Promise.withResolvers<void>();
			const unsubscribe = manager.subscribeWork(() => changed.resolve());
			const turn = rpc.completeTurn(required(task.threadId));
			await changed.promise;
			const receipt = required(manager.workReceipts(task.id)[0]);
			expect(receipt).toMatchObject({
				version: 1,
				taskId: task.id,
				turnId: turn.id,
				receiptRevision: 1,
				ownerAgentId: "kai",
				participantAgentIds: ["kai"],
				attributionStatus: "known",
				outcome: "turn_ended",
				supersedesRevision: null,
				correction: null,
				evidenceRefs: [],
			});
			rpc.emit({
				method: "turn/completed",
				params: { threadId: task.threadId, turn },
			});
			const read = await manager.read(task.id);
			await manager.handover(task.id, {
				ownerAgentId: "other",
				expectedRevision: read.task.revision,
			});
			expect(manager.workReceipts(task.id)).toEqual([receipt]);
			expect(manager.pendingWorkDeliveries()).toEqual([]);
			unsubscribe();
			await manager.close();
			manager = new TaskManager({ path: f.path, rpc });
			await manager.restore();
			expect(manager.workReceipts(task.id)).toEqual([receipt]);
			expect(rpc.calls("turn/start")).toHaveLength(1);
		} finally {
			await manager.close();
			f.close();
		}
	});
	test("unchanged reconcile observes two unseen historical terminals without guessing their owners or running inference", async () => {
		const f = workFixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const task = await createWork(manager, f.cwd);
			rpc.completeTurn(required(task.threadId));
			await manager.read(task.id);
			rpc.addExternalMessage(required(task.threadId), "mention kai");
			await manager.read(task.id);
			const before = required(manager.list()[0]);
			rpc.addExternalMessage(required(task.threadId), "mention other");
			rpc.addExternalMessage(required(task.threadId), "mention kai again");
			await manager.read(task.id);
			expect(required(manager.list()[0]).revision).toBe(before.revision);
			const receipts = manager.workReceipts(task.id);
			expect(receipts).toHaveLength(4);
			for (const r of receipts.slice(1))
				expect(r).toMatchObject({
					ownerAgentId: null,
					participantAgentIds: [],
					attributionStatus: "unknown",
					outcome: "turn_ended",
				});
			expect(rpc.calls("turn/start")).toHaveLength(1);
		} finally {
			await manager.close();
			f.close();
		}
	});
	test("running completeTurn and unknown native terminal notices never create a receipt", async () => {
		const f = workFixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const task = await createWork(manager, f.cwd);
			const barrier = Promise.withResolvers<void>();
			const off = manager.subscribe((n) => {
				if (n.type === "change") barrier.resolve();
			});
			rpc.emit({
				method: "turn/completed",
				params: {
					threadId: task.threadId,
					turn: { id: "unknown-turn", status: "future-status" },
				},
			});
			await barrier.promise;
			off();
			expect(required(manager.list()[0]).status).toBe("needs_attention");
			expect(manager.workReceipts(task.id)).toEqual([]);
		} finally {
			await manager.close();
			f.close();
		}
	});
	test("ordinary completeTurn does not assert native observation", () => {
		const f = workFixture();
		const store = new TaskStore(f.path);
		try {
			store.createPending({
				id: "task",
				requestId: "request",
				ownerAgentId: "kai",
				title: "title",
				cwd: f.cwd,
				prompt: "do",
				model: null,
				digest: "create",
			});
			store.completeTurn("task", { turnId: "turn", status: "running" });
			store.completeTurn("task", { turnId: "turn", status: "idle" });
			expect(store.workReceipts("task")).toEqual([]);
		} finally {
			store.close();
			f.close();
		}
	});
});
