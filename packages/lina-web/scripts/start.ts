import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

const { LINA_WEB_PORT, LINA_INTERVENTION_URL, LINA_WEB_ORIGIN } = process.env;
const port = Number(LINA_WEB_PORT ?? "7980");
if (!Number.isInteger(port) || port < 0 || port > 65_535)
	throw new Error("Invalid LINA_WEB_PORT");
const server = startWebServer({
	port,
	upstream: LINA_INTERVENTION_URL ?? "ws://127.0.0.1:7979",
	assets: await loadWebAssets(),
	...(LINA_WEB_ORIGIN === undefined ? {} : { publicOrigin: LINA_WEB_ORIGIN }),
});
console.log(`Lina web: http://127.0.0.1:${server.port}`);
if (LINA_WEB_ORIGIN !== undefined)
	console.log(`Lina access: ${new URL(LINA_WEB_ORIGIN).origin}`);
console.log(
	"Connects to the separately running Lina session; no agent is started by this command.",
);
const stop = (): void => {
	void server.stop(true);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
