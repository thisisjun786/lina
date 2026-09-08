import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskToolContext, TaskToolResult } from "../src/task-rpc.ts";
import { TaskManager } from "../src/tasks.ts";
import { FakeCodexRpc } from "./task-fake-rpc.test.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-task-tool-owner-"));
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

const tool = {
	type: "function" as const,
	name: "lina_work_read",
	description: "Read one file as text.",
	inputSchema: {
		type: "object",
		properties: { uri: { type: "string" } },
		required: ["uri"],
	},
};

function secretResult(): TaskToolResult {
	return {
		contentItems: [{ type: "inputText", text: "PRIVATE_TASK_PAYLOAD" }],
		success: true,
	};
}

function waitForResponse(rpc: FakeCodexRpc, id: string): Promise<void> {
	if (rpc.responses.some((item) => item.id === id)) return Promise.resolve();
	const done = Promise.withResolvers<void>();
	const original = rpc.respond.bind(rpc);
	rpc.respond = async (requestId, result) => {
		await original(requestId, result);
		if (requestId === id) done.resolve();
	};
	return done.promise;
}

test("handover during tool await fails without leaking the private payload", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	const entered = Promise.withResolvers<TaskToolContext>();
	const release = Promise.withResolvers<void>();
	const manager = new TaskManager({
		path: f.path,
		rpc,
		dynamicTools: [tool],
		executeTool: async (_tool, _callId, _args, _signal, context) => {
			if (!context) throw Error("missing host task context");
			entered.resolve(context);
			await release.promise;
			context.assertCurrent();
			return secretResult();
		},
	});
	try {
		const created = await manager.create({
			ownerAgentId: "kai",
			title: "owner-handover",
			cwd: f.cwd,
			prompt: "use the tool",
			requestId: "c-handover",
		});
		if (!created.threadId) throw Error("missing thread");
		const responded = waitForResponse(rpc, "tool-handover");
		rpc.emitRequest({
			id: "tool-handover",
			method: "item/tool/call",
			params: {
				threadId: created.threadId,
				turnId: "turn-1",
				callId: "call-1",
				namespace: null,
				tool: "lina_work_read",
				arguments: { uri: "viking://work/a.md", ownerAgentId: "forged" },
			},
		});
		const context = await entered.promise;
		expect(context.taskId).toBe(created.id);
		expect(context.agentId).toBe("kai");
		expect(context.revision).toBe(created.revision);
		expect(() => context.assertCurrent()).not.toThrow();
		await manager.handover(created.id, {
			ownerAgentId: "mira",
			expectedRevision: created.revision,
		});
		release.resolve();
		await responded;
		const response = rpc.responses.find((item) => item.id === "tool-handover");
		expect(response).toBeDefined();
		expect(response).toMatchObject({
			id: "tool-handover",
			result: { success: false },
		});
		const text = JSON.stringify(response);
		expect(text).not.toContain("PRIVATE_TASK_PAYLOAD");
		expect(text).not.toContain("forged");
		expect(text.toLowerCase()).not.toContain("mira");
		expect(text.toLowerCase()).not.toContain("kai");
	} finally {
		await manager.close();
		f.close();
	}
});

test("forged owner args cannot mint a host context", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	const seen: unknown[] = [];
	const manager = new TaskManager({
		path: f.path,
		rpc,
		dynamicTools: [tool],
		executeTool: async (_tool, _callId, args, _signal, context) => {
			seen.push({ args, context });
			if (!context) throw Error("missing host task context");
			expect(context.agentId).toBe("kai");
			context.assertCurrent();
			return secretResult();
		},
	});
	try {
		const created = await manager.create({
			ownerAgentId: "kai",
			title: "forged-args",
			cwd: f.cwd,
			prompt: "use the tool",
			requestId: "c-forged",
		});
		if (!created.threadId) throw Error("missing thread");
		const responded = waitForResponse(rpc, "tool-forged");
		rpc.emitRequest({
			id: "tool-forged",
			method: "item/tool/call",
			params: {
				threadId: created.threadId,
				turnId: "turn-1",
				callId: "call-2",
				namespace: null,
				tool: "lina_work_read",
				arguments: { uri: "viking://work/a.md", ownerAgentId: "intruder" },
			},
		});
		await responded;
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			args: { uri: "viking://work/a.md", ownerAgentId: "intruder" },
			context: {
				taskId: created.id,
				agentId: "kai",
				revision: created.revision,
			},
		});
		expect(rpc.responses[0]).toMatchObject({
			id: "tool-forged",
			result: { success: true },
		});
	} finally {
		await manager.close();
		f.close();
	}
});

test("null owner args cannot replace a stored owner, and a stable owner can complete", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	const seen: Array<string | null> = [];
	const manager = new TaskManager({
		path: f.path,
		rpc,
		dynamicTools: [tool],
		executeTool: async (_tool, _callId, _args, _signal, context) => {
			if (!context) throw Error("missing host task context");
			expect(context.agentId).not.toBeNull();
			seen.push(context.agentId);
			context.assertCurrent();
			return secretResult();
		},
	});
	try {
		const created = await manager.create({
			ownerAgentId: "kai",
			title: "stable-owner",
			cwd: f.cwd,
			prompt: "use the tool",
			requestId: "c-stable",
		});
		if (!created.threadId) throw Error("missing thread");
		const responded = waitForResponse(rpc, "tool-stable");
		rpc.emitRequest({
			id: "tool-stable",
			method: "item/tool/call",
			params: {
				threadId: created.threadId,
				turnId: "turn-1",
				callId: "call-3",
				namespace: null,
				tool: "lina_work_read",
				arguments: {
					uri: "viking://work/a.md",
					agentId: null,
					ownerAgentId: null,
				},
			},
		});
		await responded;
		expect(seen).toEqual(["kai"]);
		expect(rpc.responses).toEqual([
			{ id: "tool-stable", result: secretResult() },
		]);
	} finally {
		await manager.close();
		f.close();
	}
});

test("closed manager fails the in-flight tool without leaking payload", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	const entered = Promise.withResolvers<TaskToolContext>();
	const release = Promise.withResolvers<void>();
	const manager = new TaskManager({
		path: f.path,
		rpc,
		dynamicTools: [tool],
		executeTool: async (_tool, _callId, _args, _signal, context) => {
			if (!context) throw Error("missing host task context");
			entered.resolve(context);
			await release.promise;
			context.assertCurrent();
			return secretResult();
		},
	});
	try {
		const created = await manager.create({
			ownerAgentId: "kai",
			title: "closed-owner",
			cwd: f.cwd,
			prompt: "use the tool",
			requestId: "c-closed",
		});
		if (!created.threadId) throw Error("missing thread");
		const responded = waitForResponse(rpc, "tool-closed");
		rpc.emitRequest({
			id: "tool-closed",
			method: "item/tool/call",
			params: {
				threadId: created.threadId,
				turnId: "turn-1",
				callId: "call-4",
				namespace: null,
				tool: "lina_work_read",
				arguments: { uri: "viking://work/a.md" },
			},
		});
		await entered.promise;
		const closing = manager.close();
		release.resolve();
		await closing;
		await responded;
		const response = rpc.responses.find((item) => item.id === "tool-closed");
		expect(response).toMatchObject({
			id: "tool-closed",
			result: { success: false },
		});
		expect(JSON.stringify(response)).not.toContain("PRIVATE_TASK_PAYLOAD");
	} finally {
		f.close();
	}
});

test("overlapping duplicate tool request ids keep both close joins", async () => {
	const f = fixture();
	const rpc = new FakeCodexRpc();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	let calls = 0;
	const manager = new TaskManager({
		path: f.path,
		rpc,
		dynamicTools: [tool],
		executeTool: async (_tool, _callId, _args, _signal, context) => {
			if (!context) throw Error("missing host task context");
			const n = ++calls;
			if (n === 1) {
				firstEntered.resolve();
				await first.promise;
			} else {
				secondEntered.resolve();
				await second.promise;
			}
			context.assertCurrent();
			return secretResult();
		},
	});
	try {
		const created = await manager.create({
			ownerAgentId: "kai",
			title: "overlap-owner",
			cwd: f.cwd,
			prompt: "use the tool",
			requestId: "c-overlap",
		});
		if (!created.threadId) throw Error("missing thread");
		const request = {
			id: "tool-dup",
			method: "item/tool/call",
			params: {
				threadId: created.threadId,
				turnId: "turn-1",
				callId: "call-dup",
				namespace: null,
				tool: "lina_work_read",
				arguments: { uri: "viking://work/a.md" },
			},
		};
		rpc.emitRequest(request);
		await firstEntered.promise;
		rpc.emitRequest(request);
		await secondEntered.promise;
		const closing = manager.close();
		second.resolve();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(closed).toBe(false);
		first.resolve();
		await closing;
		expect(closed).toBe(true);
		expect(rpc.responses.filter((item) => item.id === "tool-dup")).toHaveLength(
			2,
		);
		for (const response of rpc.responses.filter(
			(item) => item.id === "tool-dup",
		)) {
			expect(response).toMatchObject({ result: { success: false } });
			expect(JSON.stringify(response)).not.toContain("PRIVATE_TASK_PAYLOAD");
		}
	} finally {
		f.close();
	}
});
