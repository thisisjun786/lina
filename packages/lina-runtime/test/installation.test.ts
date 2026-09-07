import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStartup } from "../src/installation.ts";

test("installed runtime separates resources, state and working files without creating them", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-install-"));
	try {
		const result = resolveStartup({
			resourceRoot: root,
			cwd: root,
			homeDir: root,
			env: {},
		});
		expect(result.resourceRoot).toBe(root);
		expect(result.stateRoot).toBe(join(root, ".lina/state"));
		expect(result.workspace).toBe(join(root, ".lina/workspaces/lina"));
		expect(existsSync(join(root, ".lina"))).toBe(false);
		mkdirSync(join(root, ".lina-codex-state"));
		expect(() =>
			resolveStartup({ resourceRoot: root, cwd: root, homeDir: root, env: {} }),
		).toThrow("LINA_STATE_DIR");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit legacy state retains bound workspace even with LINA_HOME", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-binding-"));
	try {
		const state = join(root, "old-state");
		mkdirSync(state);
		const sessionFile = join(state, "session.jsonl");
		writeFileSync(sessionFile, "");
		writeFileSync(
			join(state, "binding.json"),
			JSON.stringify({
				version: 1,
				botId: "lina",
				workspace: root,
				sessionFile,
				sessionId: "fixed",
			}),
		);
		const env = { LINA_HOME: join(root, "new-home"), LINA_STATE_DIR: state };
		expect(
			resolveStartup({ resourceRoot: root, cwd: root, homeDir: root, env })
				.workspace,
		).toBe(root);
		expect(() =>
			resolveStartup({
				resourceRoot: root,
				cwd: root,
				homeDir: root,
				env: { ...env, LINA_WORKSPACE: state },
			}),
		).toThrow("migration");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("staged restored homes cannot start accidentally", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-restored-"));
	try {
		writeFileSync(join(root, "restore-review.json"), "{}");
		expect(() =>
			resolveStartup({
				resourceRoot: root,
				cwd: root,
				env: { LINA_HOME: root },
			}),
		).toThrow("restore");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
