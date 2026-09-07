import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("app starts in conversation policy without delegated work instructions in its base", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-session-policy-"));
	let received = "";
	const app = await startPersistentApp({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		port: 0,
		systemPrompt:
			"# Global\nCORE\n## 8. Delegate\nEXCLUSIVE_WORK_POLICY\n## 10. Authorization\nKEEP_AUTH",
		createSession: async (options) => {
			received = options.systemPrompt;
			const b = initializeSessionFile(options.sessionFile, options.workspace);
			return new ControlledSession(b.sessionId, b.sessionFile);
		},
	});
	try {
		expect(received).toContain("KEEP_AUTH");
		expect(received).not.toContain("EXCLUSIVE_WORK_POLICY");
		expect(received).toContain("lina_select_response");
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("fleet startup forwards the same model settings source to each agent without merging rooms", async () => {
	const { AgentFleet } = await import("../src/fleet/manager.ts");
	const root = mkdtempSync(join(tmpdir(), "lina-model-fleet-"));
	let exposed = false;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "BASE",
		createApp: (options) =>
			startPersistentApp({
				...options,
				createSession: async (sdk) => {
					exposed =
						typeof (sdk as unknown as { modelSettings?: unknown })
							.modelSettings === "function";
					const b = initializeSessionFile(sdk.sessionFile, sdk.workspace);
					return new ControlledSession(b.sessionId, b.sessionFile);
				},
			}),
	});
	try {
		await fleet.app("lina");
		expect(exposed).toBe(true);
	} finally {
		await fleet.close();
		rmSync(root, { recursive: true, force: true });
	}
});
