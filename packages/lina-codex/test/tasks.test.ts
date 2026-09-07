import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError } from "../src/task-types.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-tasks-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return {
		dir,
		cwd,
		path: join(dir, "tasks.sqlite"),
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("TaskManager", () => {
	test("list is an array and create/read match the HTTP port", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			expect(manager.list()).toEqual([]);
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "fix auth",
				cwd: f.cwd,
				prompt: "repair the login path",
				requestId: "req-create-1",
			});
			expect(created.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
			if (created.threadId === null) throw new Error("missing thread");
			expect(created.status).toBe("running");
			expect(created.ownerAgentId).toBe("kai");
			expect(manager.list()).toEqual([created]);
			const read = await manager.read(created.id);
			expect(read.task.id).toBe(created.id);
			expect(read.thread?.id).toBe(created.threadId);
			expect(rpc.calls("thread/fork")).toEqual([]);
			expect(rpc.calls("thread/start")).toHaveLength(1);
			const start = rpc.calls("thread/start")[0]?.params as Record<
				string,
				unknown
			>;
			expect(start["cwd"]).toBe(f.cwd);
			expect(start["threadSource"]).toBe("lina");
			expect(start["dynamicTools"]).toBeUndefined();
			expect(start["approvalPolicy"]).not.toBe("never");
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("persists a pending create before thread/start and binds requestId", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			rpc.before("thread/start", () => {
				const listed = manager.list();
				expect(listed).toHaveLength(1);
				expect(listed[0]?.status).toBe("creating");
				expect(listed[0]?.threadId).toBeNull();
			});
			const first = await manager.create({
				ownerAgentId: "kai",
				title: "one",
				cwd: f.cwd,
				prompt: "do the work",
				requestId: "same-req",
			});
			const second = await manager.create({
				ownerAgentId: "kai",
				title: "one",
				cwd: f.cwd,
				prompt: "do the work",
				requestId: "same-req",
			});
			expect(second.id).toBe(first.id);
			expect(rpc.calls("thread/start")).toHaveLength(1);
			await expect(
				manager.create({
					ownerAgentId: "kai",
					title: "other",
					cwd: f.cwd,
					prompt: "do the work",
					requestId: "same-req",
				}),
			).rejects.toThrow(/conflict/i);
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("startup recovery fails an in-flight create and does not resend thread/start", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			rpc.gate("thread/start");
			const pending = manager.create({
				ownerAgentId: "kai",
				title: "hang",
				cwd: f.cwd,
				prompt: "start me",
				requestId: "hang-1",
			});
			await rpc.waitUntilCalled("thread/start");
			expect(manager.list()[0]?.status).toBe("creating");
			await manager.close();
			await expect(pending).rejects.toBeInstanceOf(Error);
			expect(rpc.calls("thread/start")).toHaveLength(1);
			const resumed = new TaskManager({ path: f.path, rpc });
			try {
				const listed = resumed.list();
				expect(listed).toHaveLength(1);
				const recovered = listed[0];
				if (!recovered) throw new Error("missing recovered task");
				expect(recovered.status).toBe("failed");
				expect(recovered.threadId).toBeNull();
				expect(rpc.calls("thread/start")).toHaveLength(1);
				const again = await resumed.create({
					ownerAgentId: "kai",
					title: "hang",
					cwd: f.cwd,
					prompt: "start me",
					requestId: "hang-1",
				});
				expect(again.id).toBe(recovered.id);
				expect(again.status).toBe("failed");
				expect(rpc.calls("thread/start")).toHaveLength(1);
			} finally {
				await resumed.close();
			}
		} finally {
			f.close();
		}
	});

	test("reconciles thread/read, steers with expectedTurnId, and surfaces external input", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "work",
				cwd: f.cwd,
				prompt: "first",
				requestId: "c1",
			});
			await manager.message(created.id, {
				text: "steer please",
				requestId: "m1",
				expectedRevision: created.revision,
			});
			expect(rpc.calls("turn/steer")).toHaveLength(1);
			const steer = rpc.calls("turn/steer")[0]?.params as Record<
				string,
				unknown
			>;
			const activeTurn = created.threadId
				? rpc.threads
						.get(created.threadId)
						?.turns.find((turn) => turn.status === "inProgress")
				: undefined;
			expect(steer["expectedTurnId"]).toBe(activeTurn?.id);
			rpc.completeTurn(created.threadId ?? "");
			const idle = await manager.read(created.id);
			expect(idle.task.status).toBe("idle");
			if (!created.threadId) throw new Error("missing thread");
			rpc.addExternalMessage(created.threadId, "typed in Codex");
			const seen = await manager.read(created.id);
			expect(seen.task.source).toBe("external");
			expect(seen.task.revision).toBeGreaterThan(idle.task.revision);
			await expect(
				manager.message(created.id, {
					text: "stale",
					requestId: "m-stale",
					expectedRevision: idle.task.revision,
				}),
			).rejects.toThrow(/revision/i);
			const continued = await manager.message(created.id, {
				text: "continue",
				requestId: "m2",
				expectedRevision: seen.task.revision,
			});
			expect(continued.status).toBe("running");
			expect(rpc.calls("turn/start").length).toBeGreaterThan(1);
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("duplicate turn/completed notifications emit one completion notice", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		const notices: string[] = [];
		const completions: string[] = [];
		manager.subscribe((notice) => {
			notices.push(notice.type);
			if (notice.type === "completion") completions.push(notice.noticeKey);
		});
		const delivered: { jobId: string; terminalRevision: number }[] = [];
		manager.setNotifier(async (marker) => {
			delivered.push(marker);
			return `entry-${marker.jobId}-${marker.terminalRevision}`;
		});
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "done",
				cwd: f.cwd,
				prompt: "work",
				requestId: "c-done",
			});
			if (!created.threadId) throw new Error("missing thread");
			const turn = rpc.completeTurn(created.threadId);
			rpc.emit({
				method: "turn/completed",
				params: { threadId: created.threadId, turn },
			});
			await manager.flushNotices();
			expect(completions).toHaveLength(1);
			expect(delivered).toHaveLength(1);
			expect(delivered[0]?.jobId).toBe(created.id);
			expect(delivered[0]?.terminalRevision).toBeGreaterThanOrEqual(1);
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("does not auto-approve and exposes pending approval reply", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "approve",
				cwd: f.cwd,
				prompt: "run it",
				requestId: "c-appr",
			});
			if (!created.threadId) throw new Error("missing thread");
			const request = rpc.requestApproval(created.threadId);
			const waiting = await manager.read(created.id);
			expect(waiting.task.status).toBe("waiting_approval");
			expect(waiting.task.pendingApprovals).toHaveLength(1);
			expect(rpc.responses).toEqual([]);
			const replied = await manager.reply(created.id, {
				approvalId: String(request.id),
				decision: "accept",
				expectedRevision: waiting.task.revision,
			});
			expect(rpc.responses).toHaveLength(1);
			expect(rpc.responses[0]?.id).toBe(request.id);
			expect(replied.id).toBe(created.id);
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("handover and interrupt use expected revision; concurrent messages conflict", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "race",
				cwd: f.cwd,
				prompt: "go",
				requestId: "c-race",
			});
			const handed = await manager.handover(created.id, {
				ownerAgentId: "nova",
				expectedRevision: created.revision,
			});
			expect(handed.ownerAgentId).toBe("nova");
			const first = manager.message(handed.id, {
				text: "a",
				requestId: "m-a",
				expectedRevision: handed.revision,
			});
			const second = manager.message(handed.id, {
				text: "b",
				requestId: "m-b",
				expectedRevision: handed.revision,
			});
			const results = await Promise.allSettled([first, second]);
			expect(
				results.filter((item) => item.status === "fulfilled"),
			).toHaveLength(1);
			expect(results.filter((item) => item.status === "rejected")).toHaveLength(
				1,
			);
			const live = await manager.read(created.id);
			await manager.interrupt(created.id, live.task.revision);
			expect((await manager.read(created.id)).task.status).toBe("interrupted");
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("archived native threads fail closed without forking", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "gone",
				cwd: f.cwd,
				prompt: "later",
				requestId: "c-arch",
			});
			if (!created.threadId) throw new Error("missing thread");
			rpc.archive(created.threadId);
			await expect(manager.read(created.id)).rejects.toBeInstanceOf(TaskError);
			expect(rpc.calls("thread/fork")).toEqual([]);
			expect(rpc.calls("thread/start")).toHaveLength(1);
			const listed = manager.list()[0];
			expect(listed?.threadId).toBe(created.threadId);
			expect(listed?.status).toBe("needs_attention");
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("invalidates stale approvals after reconnect and ignores requestUserInput", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "stale",
				cwd: f.cwd,
				prompt: "ask",
				requestId: "c-stale",
			});
			if (!created.threadId) throw new Error("missing thread");
			rpc.emitRequest({
				id: "user-input-1",
				method: "item/tool/requestUserInput",
				params: { threadId: created.threadId, questions: [] },
			});
			const before = await manager.read(created.id);
			expect(before.task.pendingApprovals).toEqual([]);
			const request = rpc.requestApproval(created.threadId);
			const waiting = await manager.read(created.id);
			expect(waiting.task.pendingApprovals).toHaveLength(1);
			await manager.close();
			const resumed = new TaskManager({ path: f.path, rpc });
			try {
				const listed = resumed.list()[0];
				expect(listed?.status).toBe("needs_attention");
				const read = await resumed.read(created.id);
				expect(read.task.pendingApprovals).toEqual([]);
				await expect(
					resumed.reply(created.id, {
						approvalId: String(request.id),
						decision: "accept",
						expectedRevision: read.task.revision,
					}),
				).rejects.toThrow(/unavailable|invalidated|auto-approve/i);
				const fresh = rpc.requestApproval(created.threadId);
				const live = await resumed.read(created.id);
				expect(live.task.pendingApprovals).toHaveLength(1);
				expect(live.task.pendingApprovals[0]?.id).toBe(String(fresh.id));
			} finally {
				await resumed.close();
			}
		} finally {
			f.close();
		}
	});

	test("registers OpenViking dynamic tools on thread/start and answers item/tool/call", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const calls: { tool: string; callId: string; args: unknown }[] = [];
		const manager = new TaskManager({
			path: f.path,
			rpc,
			dynamicTools: [
				{
					type: "function",
					name: "lina_work_read",
					description: "Read one OpenViking workbench file as text.",
					inputSchema: {
						type: "object",
						properties: { uri: { type: "string" } },
						required: ["uri"],
					},
				},
			],
			executeTool: async (tool, callId, args) => {
				calls.push({ tool, callId, args });
				return {
					contentItems: [{ type: "inputText", text: "work memory" }],
					success: true,
				};
			},
		});
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "tools",
				cwd: f.cwd,
				prompt: "use work memory",
				requestId: "c-tools",
			});
			const start = rpc.calls("thread/start")[0]?.params as Record<
				string,
				unknown
			>;
			expect(start["dynamicTools"]).toEqual([
				{
					type: "function",
					name: "lina_work_read",
					description: "Read one OpenViking workbench file as text.",
					inputSchema: {
						type: "object",
						properties: { uri: { type: "string" } },
						required: ["uri"],
					},
				},
			]);
			if (!created.threadId) throw new Error("missing thread");
			rpc.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: created.threadId,
					turnId: "turn-1",
					callId: "call-1",
					namespace: null,
					tool: "lina_work_read",
					arguments: { uri: "viking://work/a.md" },
				},
			});
			await Promise.resolve();
			await manager.read(created.id);
			expect(calls).toEqual([
				{
					tool: "lina_work_read",
					callId: "call-1",
					args: { uri: "viking://work/a.md" },
				},
			]);
			expect(rpc.responses).toEqual([
				{
					id: "tool-1",
					result: {
						contentItems: [{ type: "inputText", text: "work memory" }],
						success: true,
					},
				},
			]);
			rpc.emitRequest({
				id: "foreign-1",
				method: "item/tool/call",
				params: {
					threadId: "other-thread",
					turnId: "turn-x",
					callId: "call-x",
					namespace: null,
					tool: "lina_work_read",
					arguments: { uri: "viking://work/secret.md" },
				},
			});
			await Promise.resolve();
			await manager.read(created.id);
			expect(calls).toHaveLength(1);
			expect(rpc.responses).toHaveLength(1);
		} finally {
			await manager.close();
			f.close();
		}
	});

	test("unloaded threads resume the same native id", async () => {
		const f = fixture();
		const rpc = new FakeCodexRpc();
		const manager = new TaskManager({ path: f.path, rpc });
		try {
			const created = await manager.create({
				ownerAgentId: "kai",
				title: "resume",
				cwd: f.cwd,
				prompt: "keep",
				requestId: "c-res",
			});
			if (!created.threadId) throw new Error("missing thread");
			rpc.completeTurn(created.threadId);
			rpc.unload(created.threadId);
			const read = await manager.read(created.id);
			expect(read.thread?.id).toBe(created.threadId);
			expect(rpc.calls("thread/resume")).toHaveLength(1);
			const resume = rpc.calls("thread/resume")[0]?.params as Record<
				string,
				unknown
			>;
			expect(resume["threadId"]).toBe(created.threadId);
			expect(resume["history"]).toBeUndefined();
			expect(resume["path"]).toBeUndefined();
		} finally {
			await manager.close();
			f.close();
		}
	});
});

test("restoring saved loaded tasks reattaches once without sending or creating a turn", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	let manager = new TaskManager({ path: f.path, rpc });
	try {
		const created = await manager.create({
			ownerAgentId: "lina",
			title: "restore",
			cwd: f.cwd,
			prompt: "one",
			requestId: "restore-one",
		});
		if (!created.threadId) throw Error("missing thread");
		rpc.completeTurn(created.threadId);
		await manager.close();
		manager = new TaskManager({ path: f.path, rpc });
		await manager.restore();
		await manager.restore();
		expect(rpc.calls("thread/resume")).toHaveLength(1);
		expect(rpc.calls("thread/resume")[0]?.params).toMatchObject({
			threadId: created.threadId,
		});
		expect(rpc.calls("thread/start")).toHaveLength(1);
		expect(rpc.calls("turn/start")).toHaveLength(1);
		rpc.addExternalMessage(created.threadId, "direct after reconnect");
		expect((await manager.read(created.id)).task.source).toBe("external");
	} finally {
		await manager.close();
		f.close();
	}
});
