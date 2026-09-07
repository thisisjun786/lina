import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { TaskError } from "../src/task-types.ts";
import { createDigest } from "../src/tasks/protocol.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-task-store-"));
	return { dir, path: join(dir, "tasks.sqlite") };
}

describe("TaskStore", () => {
	test("persists a pending create before any native id exists", () => {
		const f = fixture();
		try {
			const store = new TaskStore(f.path);
			const digest = createDigest({
				ownerAgentId: "kai",
				title: "t",
				cwd: "/tmp/work",
				prompt: "do",
				model: null,
			});
			const created = store.createPending({
				id: "task_1",
				requestId: "req-1",
				ownerAgentId: "kai",
				title: "t",
				cwd: "/tmp/work",
				prompt: "do",
				model: null,
				digest,
			});
			expect(created.status).toBe("creating");
			expect(created.threadId).toBeNull();
			expect(
				store.createPending({
					id: "other",
					requestId: "req-1",
					ownerAgentId: "kai",
					title: "t",
					cwd: "/tmp/work",
					prompt: "do",
					model: null,
					digest,
				}).id,
			).toBe("task_1");
			expect(() =>
				store.createPending({
					id: "other",
					requestId: "req-1",
					ownerAgentId: "kai",
					title: "changed",
					cwd: "/tmp/work",
					prompt: "do",
					model: null,
					digest: createDigest({
						ownerAgentId: "kai",
						title: "changed",
						cwd: "/tmp/work",
						prompt: "do",
						model: null,
					}),
				}),
			).toThrow(TaskError);
			store.close();
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("recover fails in-flight creates without a native thread and does not invent one", () => {
		const f = fixture();
		try {
			const store = new TaskStore(f.path);
			store.createPending({
				id: "task_1",
				requestId: "req-1",
				ownerAgentId: "kai",
				title: "t",
				cwd: "/tmp/work",
				prompt: "do",
				model: null,
				digest: createDigest({
					ownerAgentId: "kai",
					title: "t",
					cwd: "/tmp/work",
					prompt: "do",
					model: null,
				}),
			});
			store.close();
			const reopened = new TaskStore(f.path);
			const recovered = reopened.recover();
			expect(recovered).toHaveLength(1);
			expect(recovered[0]?.status).toBe("failed");
			expect(recovered[0]?.threadId).toBeNull();
			expect(recovered[0]?.pendingKind).toBeNull();
			expect(recovered[0]?.lastError).toContain("did not resend");
			reopened.close();
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});
