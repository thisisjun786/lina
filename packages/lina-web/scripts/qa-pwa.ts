import { startControlServer } from "../../lina-runtime/src/control-server.ts";
import { createRuntimeFixture } from "../../lina-runtime/test/runtime-fixture.ts";
import { loadWebAssets } from "../src/assets.ts";
import { createPwaAssets } from "../src/pwa-assets.ts";
import { startWebServer } from "../src/server.ts";

const fixture = createRuntimeFixture();
const root = fixture.root;
const texts = [
	"파일과 대화 화면을 확인하고 싶어.",
	"## 함께 이어가는 일\n\n작은 변화부터 **차근차근** 정리해요.\n\n- 대화는 한곳에 저장됩니다.\n- 파일은 필요할 때 읽습니다.\n\n```ts\nconst message = '안녕, Lina';\n```\n\n<script>window.BAD=1</script> [위험](javascript:alert(1)) ![외부](https://example.com/x.png)",
];
const entries = texts.map((text, index) => ({
	type: "message",
	id: `qa-seed-${index}`,
	parentId: index ? "qa-seed-0" : null,
	timestamp: new Date().toISOString(),
	message: {
		role: index ? "assistant" : "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	},
}));
for (const [index, entry] of entries.entries())
	fixture.store.appendEntry({
		entryId: entry.id,
		role: index ? "assistant" : "user",
		text: texts[index] ?? "",
		timestamp: entry.timestamp,
		raw: entry,
	});
const backend = startControlServer({ runtime: fixture.runtime, port: 0 });
const assets = await loadWebAssets();
let web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${backend.port}`,
	assets,
});
const port = web.port;
console.log(
	JSON.stringify({
		root,
		url: `http://127.0.0.1:${port}`,
		sessionId: fixture.runtime.binding.sessionId,
		version: assets.pwa?.version,
		providerCalls: 0,
		pid: process.pid,
	}),
);
process.on("SIGUSR1", () => {
	void (async () => {
		await web.stop(true);
		const original = await loadWebAssets();
		const client = new URL("../client/", import.meta.url);
		const fresh = {
			...original,
			...createPwaAssets(
				{
					html: await Bun.file(new URL("index.html", client)).text(),
					script: original.script + "\n// isolated-update-check",
					css: original.css,
					themeScript: original.themeScript ?? "",
					icon: original.icon,
				},
				new Uint8Array(
					await Bun.file(new URL("icon-192.png", client)).arrayBuffer(),
				),
				new Uint8Array(
					await Bun.file(new URL("icon-512.png", client)).arrayBuffer(),
				),
			),
		};
		web = startWebServer({
			port: port ?? 0,
			upstream: `ws://127.0.0.1:${backend.port}`,
			assets: fresh,
		});
		console.log(
			JSON.stringify({ reloaded: true, version: fresh.pwa?.version }),
		);
	})();
});
let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await web.stop(true);
	await backend.stop();
	await fixture.close();
	process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
