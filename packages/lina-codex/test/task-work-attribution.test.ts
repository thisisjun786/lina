import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CodexRpcRemoteError } from "../src/rpc.ts";
import { TaskStore } from "../src/task-store.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";
import { createWork, required, workFixture } from "./task-work-fixture.ts";

class LostStartResponseRpc extends FakeCodexRpc {
	lost = false;
	lostMethod = "turn/start";
	unavailable = false;
	override async request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		if (method === "thread/read" && this.unavailable)
			throw new Error("native read unavailable");
		const response = await super.request<T>(method, params, signal);
		if (method === this.lostMethod && !this.lost) {
			this.lost = true;
			this.completeTurn(required([...this.threads.values()].at(-1)).id);
			throw new Error("accepted native turn but start response lost");
		}
		return response;
	}
}

test("T1 completion preceding a lost start response resolves exact managed correlation before receipt publication", async () => {
	const f = workFixture();
	const rpc = new LostStartResponseRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	const observedOwners: (string | null)[] = [];
	try {
		manager.subscribeWork((change) => {
			for (const receipt of manager.workReceipts(change.taskId))
				observedOwners.push(receipt.ownerAgentId);
		});
		await expect(createWork(manager, f.cwd)).rejects.toThrow(/response lost/);
		const task = required(manager.list()[0]);
		await manager.read(task.id);
		const db = new DatabaseSync(f.path);
		const input = required(
			db
				.prepare(
					"SELECT owner_agent_id,turn_id FROM task_work_inputs WHERE request_id='create-1'",
				)
				.get(),
		);
		expect(input["owner_agent_id"]).toBe("kai");
		expect(input["turn_id"]).toBe("turn-3");
		db.close();
		const baseline = required(manager.workReceipts(task.id)[0]);
		expect(baseline).toMatchObject({
			turnId: "turn-3",
			ownerAgentId: "kai",
			participantAgentIds: ["kai"],
			attributionStatus: "known",
			receiptRevision: 1,
		});
		expect(observedOwners).toEqual(["kai"]);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		expect(manager.workReceipts(task.id)).toEqual([baseline]);
		expect(rpc.calls("turn/start")).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});

test("T1 unavailable correlation defers immutable receipt durably through reopen until exact native input is readable", async () => {
	const f = workFixture();
	const rpc = new LostStartResponseRpc();
	rpc.unavailable = true;
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		await expect(createWork(manager, f.cwd)).rejects.toThrow(/response lost/);
		const task = required(manager.list()[0]);
		await expect(manager.read(task.id)).rejects.toThrow(/unavailable/);
		expect(manager.workReceipts(task.id)).toEqual([]);
		const db = new DatabaseSync(f.path);
		expect(
			db.prepare("SELECT native_status FROM task_work_observations").all(),
		).toEqual([{ native_status: "completed" }]);
		const observedRevision = required(
			db.prepare("SELECT task_revision FROM task_work_observations").get(),
		)["task_revision"];
		db.close();
		await manager.handover(task.id, {
			ownerAgentId: "nina",
			expectedRevision: required(manager.list()[0]).revision,
		});
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		expect(manager.workReceipts(task.id)).toEqual([]);
		rpc.unavailable = false;
		await manager.restore();
		const baseline = required(manager.workReceipts(task.id)[0]);
		expect(baseline).toMatchObject({
			ownerAgentId: "kai",
			participantAgentIds: ["kai"],
			attributionStatus: "known",
			taskRevision: observedRevision,
		});
		await manager.restore();
		expect(manager.workReceipts(task.id)).toEqual([baseline]);
		expect(rpc.calls("turn/start")).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});

for (const mutation of [
	"wrong-owner",
	"later-owner",
	"participants",
] as const) {
	test(`T2 restore rejects ${mutation} baseline attribution against unchanged managed sources`, async () => {
		const f = workFixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const task = await createWork(manager, f.cwd);
			await manager.handover(task.id, {
				ownerAgentId: "nina",
				expectedRevision: task.revision,
			});
			rpc.completeTurn(required(task.threadId));
			await manager.read(task.id);
			const baseline = required(manager.workReceipts(task.id)[0]);
			expect(baseline).toMatchObject({
				ownerAgentId: "kai",
				participantAgentIds: ["kai", "nina"],
			});
			await manager.close();
			const db = new DatabaseSync(f.path);
			const inputs = db.prepare("SELECT * FROM task_work_inputs").all();
			const handovers = db.prepare("SELECT * FROM task_work_handovers").all();
			const forged =
				mutation === "participants"
					? { ...baseline, participantAgentIds: ["kai"] }
					: {
							...baseline,
							ownerAgentId: mutation === "later-owner" ? "nina" : "wrong-agent",
							participantAgentIds:
								mutation === "later-owner" ? ["nina"] : ["wrong-agent"],
						};
			db.prepare(
				"UPDATE task_work_receipts SET receipt_json=? WHERE receipt_revision=1",
			).run(JSON.stringify(forged));
			expect(db.prepare("SELECT * FROM task_work_inputs").all()).toEqual(
				inputs,
			);
			expect(db.prepare("SELECT * FROM task_work_handovers").all()).toEqual(
				handovers,
			);
			db.close();
			expect(() => {
				const reopened = new TaskStore(f.path);
				reopened.close();
			}).toThrow(/attribution/);
		} finally {
			await manager.close();
			f.close();
		}
	});
}

test("T2 source input mutation invalidates original observation reference", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		await manager.close();
		const db = new DatabaseSync(f.path);
		db.exec("UPDATE task_work_inputs SET owner_agent_id='wrong-agent'");
		db.close();
		expect(() => {
			const reopened = new TaskStore(f.path);
			reopened.close();
		}).toThrow(/attribution input source mismatch/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("pending observation identity is validated before restore admission", async () => {
	const f = workFixture();
	const rpc = new LostStartResponseRpc();
	rpc.unavailable = true;
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		await expect(createWork(manager, f.cwd)).rejects.toThrow(/response lost/);
		const task = required(manager.list()[0]);
		await expect(manager.read(task.id)).rejects.toThrow(/unavailable/);
		await manager.close();
		const db = new DatabaseSync(f.path);
		db.exec("UPDATE task_work_observations SET turn_id='changed-turn'");
		db.close();
		expect(() => {
			const reopened = new TaskStore(f.path);
			reopened.close();
		}).toThrow(/observation/);
	} finally {
		await manager.close();
		f.close();
	}
});

test("T1 accepted steer with lost response retains both managed participants before terminal publication", async () => {
	const f = workFixture();
	const rpc = new LostStartResponseRpc();
	rpc.lostMethod = "turn/steer";
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		const handed = await manager.handover(task.id, {
			ownerAgentId: "nina",
			expectedRevision: task.revision,
		});
		await expect(
			manager.message(task.id, {
				text: "steer",
				requestId: "steer-request",
				expectedRevision: handed.revision,
			}),
		).rejects.toThrow(/response lost/);
		await manager.read(task.id);
		expect(manager.workReceipts(task.id)[0]).toMatchObject({
			ownerAgentId: "kai",
			participantAgentIds: ["kai", "nina"],
			attributionStatus: "known",
		});
		expect(manager.workReceipts(task.id)).toHaveLength(1);
		expect(rpc.calls("turn/start")).toHaveLength(1);
		expect(rpc.calls("turn/steer")).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});

test("T2 changing a captured handover invalidates the original source reference", async () => {
	const f = workFixture();
	const rpc = new FakeCodexRpc();
	const manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		await manager.handover(task.id, {
			ownerAgentId: "nina",
			expectedRevision: task.revision,
		});
		rpc.completeTurn(required(task.threadId));
		await manager.read(task.id);
		await manager.close();
		const db = new DatabaseSync(f.path);
		db.exec("UPDATE task_work_handovers SET to_owner='wrong-agent'");
		db.close();
		expect(() => {
			const reopened = new TaskStore(f.path);
			reopened.close();
		}).toThrow(/attribution handover source mismatch/);
	} finally {
		await manager.close();
		f.close();
	}
});

class EndBeforeSteerRpc extends FakeCodexRpc {
	definitive = false;
	override async request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		if (method === "turn/steer") {
			const body = params as { threadId: string };
			this.completeTurn(body.threadId);
		}
		try {
			return await super.request<T>(method, params, signal);
		} catch (error) {
			if (this.definitive && method === "turn/steer")
				throw new CodexRpcRemoteError("expectedTurnId does not match", -32602);
			throw error;
		}
	}
}
test("T3 an unresolved rejected steer cannot block a later independently accepted turn", async () => {
	const f = workFixture(),
		rpc = new EndBeforeSteerRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		const first = await createWork(manager, f.cwd);
		await expect(
			manager.message(first.id, {
				text: "too late",
				requestId: "rejected-steer",
				expectedRevision: first.revision,
			}),
		).rejects.toThrow(/expectedTurnId/);
		await manager.read(first.id);
		const second = await manager.message(first.id, {
			text: "new turn",
			requestId: "next-valid",
			expectedRevision: required(manager.list()[0]).revision,
		});
		const secondTurn = (await manager.read(first.id)).task.lastTurnId;
		rpc.completeTurn(required(second.threadId));
		await manager.read(first.id);
		expect(
			manager
				.workReceipts(first.id)
				.some((r) => r.turnId === secondTurn && r.ownerAgentId === "kai"),
		).toBe(true);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		expect(
			manager
				.workReceipts(first.id)
				.some((r) => r.turnId === secondTurn && r.ownerAgentId === "kai"),
		).toBe(true);
	} finally {
		await manager.close();
		f.close();
	}
});

test("T3 definitive native rejection releases the affected receipt while ambiguous errors retain pending attribution", async () => {
	const f = workFixture(),
		rpc = new EndBeforeSteerRpc();
	rpc.definitive = true;
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		const task = await createWork(manager, f.cwd);
		await expect(
			manager.message(task.id, {
				text: "late",
				requestId: "rejected",
				expectedRevision: task.revision,
			}),
		).rejects.toThrow(/expectedTurnId/);
		await manager.read(task.id);
		expect(manager.workReceipts(task.id)).toHaveLength(1);
		expect(manager.workReceipts(task.id)[0]?.ownerAgentId).toBe("kai");
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		expect(manager.workReceipts(task.id)).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});

test("T3 an ambiguous earlier start cannot own a later turn with a different exact start input", async () => {
	const f = workFixture();
	let first = true;
	const rpc = new FakeCodexRpc(),
		native = rpc.request.bind(rpc);
	rpc.request = async <T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T> => {
		if (method === "turn/start" && first) {
			first = false;
			throw Error("ambiguous transport failure");
		}
		return native<T>(method, params, signal);
	};
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		await expect(createWork(manager, f.cwd)).rejects.toThrow(/ambiguous/);
		const task = required(manager.list()[0]);
		await manager.read(task.id);
		const next = await manager.message(task.id, {
			text: "new accepted input",
			requestId: "known-next",
			expectedRevision: required(manager.list()[0]).revision,
		});
		rpc.completeTurn(required(next.threadId));
		await manager.read(task.id);
		expect(manager.workReceipts(task.id)).toHaveLength(1);
		expect(manager.workReceipts(task.id)[0]?.attributionStatus).toBe("known");
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		expect(manager.workReceipts(task.id)).toHaveLength(1);
	} finally {
		await manager.close();
		f.close();
	}
});
