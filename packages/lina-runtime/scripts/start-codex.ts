import { fileURLToPath } from "node:url";
import { checkedDirectory } from "../../lina-core/src/attachments/filesystem.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";
import { resolveStartup } from "../src/installation.ts";

const startup = resolveStartup({
	resourceRoot: fileURLToPath(new URL("../../../", import.meta.url)),
});
checkedDirectory(startup.workspace, true);
const app = await startCodexFleet({
	...startup,
	defaultTaskMode:
		process.env["LINA_STATE_DIR"] || process.env["LINA_CODEX_SOCKET"]
			? "shared"
			: "owned",
});
console.error(
	`[lina] Codex backend; loopback controller :${app.port}; agents start on demand`,
);
console.error(
	`[lina] OpenCodex ${app.hub.status().connected ? "connected" : "unavailable; model settings remain accessible"}`,
);
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void app.stop().then(
		() => process.exit(0),
		() => {
			console.error(
				"[lina] Shutdown failed; inspect the owned runtime before restarting",
			);
			process.exit(1);
		},
	);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
