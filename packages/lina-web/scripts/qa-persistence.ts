import { randomUUID } from "node:crypto";
import { startControlServer } from "../../lina-runtime/src/control-server.ts";
import { createRuntimeFixture } from "../../lina-runtime/test/runtime-fixture.ts";
import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

// Explicit test fixture: no credentials, real SQLite and sockets, deterministic replies.
const fixture = createRuntimeFixture();
const { LINA_QA_HISTORY } = process.env;
const historyCount = Number(LINA_QA_HISTORY ?? 105);
if (
	!Number.isSafeInteger(historyCount) ||
	historyCount < 0 ||
	historyCount > 2000
)
	throw new Error("Invalid QA history count");
for (let i = 0; i < historyCount; i++)
	fixture.store.appendEntry({
		entryId: `old-${i}`,
		role: i % 2 ? "assistant" : "user",
		text: `저장된 메모 ${i}`,
		timestamp: new Date().toISOString(),
		raw: { fixture: true, index: i },
	});
fixture.store.appendEntry({
	entryId: "long-answer",
	role: "assistant",
	text: "긴 답변 원문입니다. ".repeat(900),
	timestamp: new Date().toISOString(),
	raw: { fixture: true },
});
fixture.native.onPrompt = async (text, admission) => {
	admission.disposition("started");
	fixture.native.user(randomUUID(), text);
	fixture.native.emit({
		type: "entry_appended",
		entry: {
			type: "message",
			id: randomUUID(),
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `확인했어요: ${text}` }],
			},
		},
	});
	fixture.native.emit({ type: "agent_settled" });
};
const backend = startControlServer({ runtime: fixture.runtime, port: 0 });
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${backend.port}`,
	assets: await loadWebAssets(),
});
console.log(`LINA_QA_URL=http://127.0.0.1:${web.port}`);
const stop = () => {
	void (async () => {
		await web.stop(true);
		await backend.stop();
		await fixture.close();
		process.exit(0);
	})();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
