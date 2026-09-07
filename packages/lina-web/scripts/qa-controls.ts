import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { startControlServer } from "../../lina-runtime/src/control-server.ts";
import { ExecutionCoordinator } from "../../lina-runtime/src/execution.ts";
import type { PromptAdmission } from "../../lina-runtime/src/sdk-port.ts";
import { createRuntimeFixture } from "../../lina-runtime/test/runtime-fixture.ts";
import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

// Isolated UI fixture: actual control store, gate and filesystem; no model credentials.
let execution: ExecutionCoordinator;
const fixture = createRuntimeFixture({
	beforeAbort: () => execution.abortAll(),
});
const controls = new ControlStore(
	join(fixture.root, "control.sqlite"),
	fixture.runtime.binding,
);
execution = new ExecutionCoordinator({
	store: controls,
	gate: new ApprovalGate(controls),
	requestId: () => fixture.runtime.currentRequestId(),
	runtimeState: () => ({
		cancelling: fixture.runtime.isCancelling,
		cancelFailed: fixture.runtime.cancelFailed,
		cancelRequestId: fixture.runtime.cancelRequestId(),
	}),
});
let controller: AbortController | undefined,
	task: Promise<void> | undefined,
	sequence = 0;
let failAbortOnce = false;
async function run(text: string, admission: PromptAdmission): Promise<void> {
	controller = new AbortController();
	failAbortOnce = text.includes("FAIL_CANCEL");
	const signal = controller.signal;
	const number = ++sequence,
		callId = randomUUID(),
		file = join(fixture.root, `operation-${number}.txt`),
		input = { path: file, content: text };
	fixture.native.emit({ type: "agent_start" });
	fixture.native.user(randomUUID(), text);
	admission.disposition("started");
	try {
		execution.begin(callId, "write", input);
		const decision = await execution.authorize(callId, "write", input, signal);
		if (decision.allow && !signal.aborted) {
			writeFileSync(file, text);
			execution.end(
				callId,
				{ content: [{ type: "text", text: "파일을 저장했습니다." }] },
				false,
			);
			fixture.native.emit({
				type: "entry_appended",
				entry: {
					type: "message",
					id: randomUUID(),
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "요청한 파일을 저장했어요." }],
					},
				},
			});
		} else
			execution.end(
				callId,
				{
					content: [
						{ type: "text", text: decision.reason ?? "실행하지 않았습니다." },
					],
				},
				true,
			);
	} finally {
		execution.settled();
		fixture.native.emit({ type: "agent_settled" });
	}
}
fixture.native.onPrompt = (text, admission) => {
	task = run(text, admission);
	return task;
};
fixture.native.abort = async () => {
	if (failAbortOnce) {
		failAbortOnce = false;
		throw new Error("Injected abort failure");
	}
	controller?.abort();
	await task;
};
const off = fixture.runtime.subscribe((event) => {
	if (event.type === "snapshot") execution.refresh();
});
const backend = startControlServer({
	runtime: fixture.runtime,
	execution,
	port: 0,
});
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${backend.port}`,
	assets: await loadWebAssets(),
});
console.log(
	JSON.stringify({ url: `http://127.0.0.1:${web.port}`, root: fixture.root }),
);
const stop = () => {
	void (async () => {
		await web.stop(true);
		await backend.stop();
		off();
		await fixture.runtime.close();
		execution.close();
		controls.close();
		await fixture.close();
		process.exit(0);
	})();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
