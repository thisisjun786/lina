import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskManager } from "../src/tasks.ts";
export function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("missing fixture value");
	return value;
}
export function workFixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-task-work-"));
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return {
		dir,
		cwd,
		path: join(dir, "tasks.sqlite"),
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}
export async function createWork(manager: TaskManager, cwd: string) {
	return manager.create({
		ownerAgentId: "kai",
		title: "work",
		cwd,
		prompt: "private input",
		requestId: "create-1",
	});
}
