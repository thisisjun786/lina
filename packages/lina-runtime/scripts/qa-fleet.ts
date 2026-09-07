import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWebAssets } from "../../lina-web/src/assets.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import { startTestApp } from "../test/fake-session-engine.ts";

const root = mkdtempSync(join(tmpdir(), "lina-fleet-qa-"));
const fleet = new AgentFleet({
	workspace: process.cwd(),
	stateRoot: root,
	agentDir: join(root, "auth"),
	systemPrompt: readFileSync("data/app-system-prompt.md", "utf8"),
	createApp: startTestApp,
});
const backend = await startFleetServer(fleet, 0, process.cwd());
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${backend.port}`,
	assets: await loadWebAssets(),
});
console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}`,
		root,
		providerCalls: 0,
	}),
);
let stopped = false;
const stop = async () => {
	if (stopped) return;
	stopped = true;
	await web.stop(true);
	await backend.stop();
	process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
