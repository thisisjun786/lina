import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError } from "../src/task-types.ts";
import { validateWorkspace } from "../src/tasks/workspace.ts";

describe("validateWorkspace", () => {
	test("accepts a canonical absolute directory and rejects relative or missing paths", () => {
		const root = mkdtempSync(join(tmpdir(), "lina-task-ws-"));
		try {
			const cwd = join(root, "work");
			mkdirSync(cwd);
			expect(validateWorkspace(cwd)).toBe(cwd);
			expect(() => validateWorkspace("relative/path")).toThrow(TaskError);
			expect(() => validateWorkspace(join(root, "missing"))).toThrow(TaskError);
			writeFileSync(join(root, "file"), "x");
			expect(() => validateWorkspace(join(root, "file"))).toThrow(TaskError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a symlink workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "lina-task-link-"));
		try {
			const real = join(root, "real");
			mkdirSync(real);
			const link = join(root, "link");
			symlinkSync(real, link);
			expect(() => validateWorkspace(link)).toThrow(TaskError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
