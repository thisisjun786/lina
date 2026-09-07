import { createImageAppFixture } from "../../lina-runtime/test/image-app-fixture.ts";
import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

const fixture = await createImageAppFixture();
let web: ReturnType<typeof startWebServer>;
try {
	web = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${fixture.app.port}`,
		assets: await loadWebAssets(),
	});
} catch (error) {
	await fixture.close();
	throw error;
}

console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}`,
		root: fixture.root,
		sessionId: fixture.app.binding.sessionId,
		imageService: fixture.ima2.baseUrl,
		externalProviderCalls: 0,
		commands: ["generate", "edit", "generate fail"],
		images: "320x200: blue generation, green edit",
	}),
);

let stopping: Promise<void> | undefined;
function stop(): void {
	if (stopping) return;
	stopping = (async () => {
		await web.stop(true);
		await fixture.close(true);
		console.log(
			JSON.stringify({
				root: fixture.root,
				generationRequests: fixture.ima2.submissions.length,
				toolCalls: fixture.rpc.calls.map((call) => call.tool),
				externalProviderCalls: 0,
			}),
		);
	})().catch((error: unknown) => {
		console.error(
			"[image-engine-qa]",
			error instanceof Error ? error.message : String(error),
		);
		process.exitCode = 1;
	});
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
