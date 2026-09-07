import { fileURLToPath } from "node:url";
import { checkedDirectory } from "../../lina-core/src/attachments/filesystem.ts";
import { loadWebAssets } from "../../lina-web/src/assets.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";
import { resolveStartup } from "../src/installation.ts";

const startup = resolveStartup({
	resourceRoot: fileURLToPath(new URL("../../../", import.meta.url)),
});
checkedDirectory(startup.workspace, true);
const runtime = await startCodexFleet({ ...startup, defaultTaskMode: "owned" });
try {
	const web = startWebServer({
		port: 7980,
		hostname: "0.0.0.0",
		upstream: `ws://127.0.0.1:${runtime.port}`,
		assets: await loadWebAssets(),
	});
	let closing = false;
	const stop = () => {
		if (closing) return;
		closing = true;
		void (async () => {
			await web.stop(true);
			await runtime.stop();
		})().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	console.log("Lina container web ready on :7980");
} catch (error) {
	await runtime.stop();
	throw error;
}
