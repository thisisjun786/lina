import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskConnectionSpec } from "../src/fleet/task-connection.ts";

test("persisted task mode survives a changed startup default after offline startup", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-default-"));
	try {
		const first = taskConnectionSpec({
			stateRoot: root,
			homeDir: root,
			env: { LINA_CODEX_TASK_MODE: "owned" },
		});
		expect(
			taskConnectionSpec({ stateRoot: root, homeDir: root, env: {} }),
		).toEqual(first);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("owned task mode rejects an ambient shared socket", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-conflict-"));
	try {
		expect(() =>
			taskConnectionSpec({
				stateRoot: root,
				homeDir: root,
				env: {
					LINA_CODEX_TASK_MODE: "owned",
					LINA_CODEX_SOCKET: "/shared.sock",
				},
			}),
		).toThrow("LINA_CODEX_SOCKET");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saved tasks cannot silently switch to a different shared Codex socket", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-binding-"));
	try {
		taskConnectionSpec({
			stateRoot: root,
			homeDir: root,
			env: { LINA_CODEX_SOCKET: "/first.sock" },
		});
		expect(() =>
			taskConnectionSpec({
				stateRoot: root,
				homeDir: root,
				env: { LINA_CODEX_SOCKET: "/second.sock" },
			}),
		).toThrow("migration");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("owned task execution uses Lina state and never a shared socket", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-mode-"));
	try {
		const spec = taskConnectionSpec({
			stateRoot: root,
			homeDir: root,
			env: { LINA_CODEX_TASK_MODE: "owned" },
		});
		expect(spec).toEqual({
			mode: "owned",
			stateRoot: join(root, "task-engine"),
		});
		expect(() =>
			taskConnectionSpec({
				stateRoot: root,
				homeDir: root,
				env: { LINA_CODEX_TASK_MODE: "shared" },
			}),
		).toThrow("migration");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy task connection remains shared and rejects ambiguous mode", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-mode-"));
	try {
		expect(
			taskConnectionSpec({
				stateRoot: root,
				homeDir: root,
				env: { LINA_CODEX_SOCKET: "/selected.sock" },
			}),
		).toEqual({ mode: "shared", socket: "/selected.sock" });
		expect(() =>
			taskConnectionSpec({
				stateRoot: root,
				homeDir: root,
				env: { LINA_CODEX_TASK_MODE: "auto" },
			}),
		).toThrow("LINA_CODEX_TASK_MODE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
