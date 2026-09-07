import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp as startPersistentApp } from "./fake-session-engine.ts";
import { openFrameClient } from "./socket-client.ts";

test("context subscribe and scoped failure remain separate from conversation errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-context-server-"));
	const app = await startPersistentApp({
		workspace: root,
		stateRoot: join(root, "state"),
		agentDir: join(root, "auth"),
		systemPrompt: "Lina",
		port: 0,
	});
	const peer = await openFrameClient(`ws://127.0.0.1:${app.port}`);
	try {
		await peer.next();
		peer.send({ type: "subscribe", version: 2 });
		await peer.until("snapshot");
		await peer.until("control-state");
		expect(await peer.next()).toMatchObject({
			type: "context-state",
			state: { sessionId: app.binding.sessionId, busy: false },
		});
		peer.send({ type: "compact", sessionId: "foreign" });
		expect(await peer.until("context-error")).toMatchObject({
			type: "context-error",
		});
		peer.send({ type: "context-refresh", sessionId: app.binding.sessionId });
		expect(await peer.until("context-state")).toMatchObject({
			state: { memory: { service: "disabled" } },
		});
	} finally {
		peer.close();
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
