import { expect, test } from "bun:test";
import { createCodexTaskTools } from "../src/tools/codex-tasks.ts";

test("assistant task mutation refuses another owner's task while read remains shared", async () => {
	let sends = 0;
	const manager = {
		list: () => ({ tasks: [] }),
		read: async () => ({
			task: { ownerAgentId: "kai", revision: 2 },
			thread: { id: "native" },
		}),
		create: async () => ({}),
		message: async () => {
			sends++;
			return {};
		},
		interrupt: async () => ({}),
		handover: async () => ({}),
	};
	const tools = createCodexTaskTools(
		manager,
		"lina",
		(id) => id === "kai" || id === "lina",
	);
	const send = tools.find((t) => t.name === "lina_task_send");
	if (!send) throw Error("missing tool");
	await expect(
		send.execute(
			"call",
			{ taskId: "task", text: "go", expectedRevision: 2 },
			new AbortController().signal,
		),
	).rejects.toThrow("owner");
	expect(sends).toBe(0);
	const read = tools.find((t) => t.name === "lina_task_read");
	if (!read) throw Error("missing tool");
	expect(
		(
			await read.execute(
				"read",
				{ taskId: "task" },
				new AbortController().signal,
			)
		).content.length,
	).toBeGreaterThan(0);
});
