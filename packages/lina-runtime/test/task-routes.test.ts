import { expect, test } from "bun:test";
import { taskRoutes } from "../src/fleet/task-routes.ts";

test("task routes reject malformed revisions and unknown assistant owners before dispatch", async () => {
	let calls = 0;
	const tasks = {
		list: () => [],
		create: async () => {
			calls++;
			return {};
		},
		read: async () => ({ task: {}, thread: {} }),
		message: async () => {
			calls++;
			return {};
		},
		interrupt: async () => {
			calls++;
			return {};
		},
		handover: async () => {
			calls++;
			return {};
		},
	};
	const bad = await taskRoutes(
		new Request("http://localhost/api/tasks", { method: "POST" }),
		tasks,
		(id) => id === "lina",
		async () => ({
			ownerAgentId: "missing",
			title: "task",
			cwd: "/tmp",
			prompt: "hello",
			requestId: "r1",
		}),
	);
	expect(bad?.status).toBe(400);
	const stale = await taskRoutes(
		new Request("http://localhost/api/tasks/t1/messages", { method: "POST" }),
		tasks,
		() => true,
		async () => ({ text: "go", requestId: "r2", expectedRevision: -1 }),
	);
	expect(stale?.status).toBe(400);
	expect(calls).toBe(0);
	const unknown = await taskRoutes(
		new Request("http://localhost/api/tasks/t1/owner", { method: "POST" }),
		tasks,
		() => true,
		async () => ({ ownerAgentId: "lina", expectedRevision: 0, admin: true }),
	);
	expect(unknown?.status).toBe(400);
});
test("task routes preserve conflicts and call original task identity", async () => {
	const ids: string[] = [];
	const tasks = {
		list: () => [],
		create: async () => ({}),
		read: async (id: string) => {
			ids.push(id);
			return { task: { id }, thread: { id: "native" } };
		},
		message: async () => {
			throw Error("revision conflict");
		},
		interrupt: async () => ({}),
		handover: async () => ({}),
	};
	const read = await taskRoutes(
		new Request("http://localhost/api/tasks/original"),
		tasks,
		() => true,
		async () => ({}),
	);
	expect(await read?.json()).toEqual({
		task: { id: "original" },
		thread: { id: "native" },
	});
	expect(ids).toEqual(["original"]);
	const conflict = await taskRoutes(
		new Request("http://localhost/api/tasks/original/messages", {
			method: "POST",
		}),
		tasks,
		() => true,
		async () => ({ text: "continue", requestId: "r1", expectedRevision: 0 }),
	);
	expect(conflict?.status).toBe(409);
});

test("approval route validates explicit decisions and preserves native pending request identity", async () => {
	const calls: unknown[] = [];
	const tasks = {
		list: () => [],
		create: async () => ({}),
		read: async () => ({}),
		message: async () => ({}),
		interrupt: async () => ({}),
		handover: async () => ({}),
		reply: async (...args: unknown[]) => {
			calls.push(args);
			return { id: "t1", revision: 5 };
		},
	};
	const request = () =>
		new Request("http://localhost/api/tasks/t1/approval", { method: "POST" });
	const invalid = await taskRoutes(
		request(),
		tasks,
		() => true,
		async () => ({
			approvalId: "rpc:7",
			decision: "always",
			expectedRevision: 4,
		}),
	);
	expect(invalid?.status).toBe(400);
	expect(calls).toEqual([]);
	const accepted = await taskRoutes(
		request(),
		tasks,
		() => true,
		async () => ({
			approvalId: "rpc:7",
			decision: "accept",
			expectedRevision: 4,
		}),
	);
	expect(accepted?.status).toBe(200);
	expect(calls).toEqual([
		["t1", { approvalId: "rpc:7", decision: "accept", expectedRevision: 4 }],
	]);
});

test("task routes distinguish unavailable engine and missing tasks without leaking native details", async () => {
	let code = "unknown_task";
	const tasks = {
		list: () => [],
		create: async () => ({}),
		read: async () => {
			throw Object.assign(Error("private path details"), { code });
		},
		message: async () => ({}),
		interrupt: async () => ({}),
		handover: async () => ({}),
	};
	const run = () =>
		taskRoutes(
			new Request("http://localhost/api/tasks/missing"),
			tasks,
			() => true,
			async () => ({}),
		);
	expect((await run())?.status).toBe(404);
	code = "native_unavailable";
	const unavailable = await run();
	expect(unavailable?.status).toBe(502);
	expect(await unavailable?.text()).not.toContain("private path");
});
