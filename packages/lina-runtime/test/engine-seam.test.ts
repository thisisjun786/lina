import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppOptions, startPersistentApp } from "../src/session-app.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanup.splice(0).reverse()) await c();
});
test("missing Codex engine fails before creating state or loading a legacy runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-no-engine-"));
	cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
	const stateRoot = join(root, "state");
	await expect(
		startPersistentApp({
			workspace: root,
			stateRoot,
			agentDir: join(root, "auth"),
			systemPrompt: "Lina",
			port: 0,
		} as AppOptions),
	).rejects.toThrow("Codex engine");
	expect(existsSync(stateRoot)).toBe(false);
});
test("Codex engine owns identity without loading a legacy file format and preserves it on restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-engine-"));
	cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
	let initialized = 0;
	const engine = {
		kind: "codex" as const,
		inspect: () => {},
		initialize: (file: string) => {
			initialized++;
			if (!readFileSync(file, "utf8"))
				writeFileSync(file, '{"engine":"test"}\n');
			return { sessionId: "logical-assistant", sessionFile: file };
		},
		create: async (options: { sessionFile: string }) =>
			new ControlledSession("logical-assistant", options.sessionFile),
	};
	const config = {
		workspace: root,
		stateRoot: join(root, "state"),
		agentDir: join(root, "engine"),
		systemPrompt: "Lina",
		port: 0,
		engine,
	};
	const first = await startPersistentApp(config);
	expect("jobs" in first).toBe(false);
	await first.stop();
	const second = await startPersistentApp(config);
	cleanup.push(second.stop);
	expect(second.binding.sessionId).toBe("logical-assistant");
	expect(initialized).toBe(2);
});
