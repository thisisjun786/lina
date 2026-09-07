import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { parseApprovalMode } from "../../lina-runtime/src/approval-policy.ts";
import { startControlServer } from "../../lina-runtime/src/control-server.ts";
import { ExecutionCoordinator } from "../../lina-runtime/src/execution.ts";
import type { PromptAdmission } from "../../lina-runtime/src/sdk-port.ts";
import { createRuntimeFixture } from "../../lina-runtime/test/runtime-fixture.ts";
import { loadWebAssets } from "../src/assets.ts";
import { startWebServer } from "../src/server.ts";

let execution: ExecutionCoordinator;
const fixture = createRuntimeFixture({
	beforeAbort: () => execution.abortAll(),
});
const controls = new ControlStore(
	join(fixture.root, "control.sqlite"),
	fixture.runtime.binding,
);
const mode = parseApprovalMode(process.env["LINA_QA_APPROVAL_MODE"]);
const nativeAsk = process.env["LINA_QA_NATIVE_ASK"] === "1";
execution = new ExecutionCoordinator({
	store: controls,
	gate: new ApprovalGate(controls),
	approvalMode: mode,
	requestId: () => fixture.runtime.currentRequestId(),
	runtimeState: () => ({
		cancelling: fixture.runtime.isCancelling,
		cancelFailed: fixture.runtime.cancelFailed,
		cancelRequestId: fixture.runtime.cancelRequestId(),
	}),
});
// Synthetic engine permission decision; no installed runtime policy is read.
execution.configurePermissions(() => ({ action: nativeAsk ? "ask" : "allow" }));
const long =
	'LARGE_TOOL_OUTPUT_<img src="/qa-missing" onerror="window.QA_BAD=1">\n' +
	"line\n".repeat(4000);
for (const [id, name, isError, text] of [
	["ok", "bash", false, long],
	["failed", "read", true, "SYNTHETIC_FAILURE"],
	["empty", "image_tool", false, ""],
] as const) {
	fixture.store.appendEntry({
		entryId: id,
		role: "tool",
		text,
		timestamp: new Date().toISOString(),
		raw: {
			type: "message",
			message: {
				role: "toolResult",
				toolName: name,
				isError,
				content: [{ type: "text", text }],
			},
		},
	});
}
fixture.store.appendEntry({
	entryId: "answer",
	role: "assistant",
	text: "메모를 정리했습니다.\n\n```ts\nconst total = 42;\n```",
	timestamp: new Date().toISOString(),
	raw: {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "메모를 정리했습니다.\n\n```ts\nconst total = 42;\n```",
				},
			],
		},
	},
});
fixture.store.appendEntry({
	entryId: "commentary",
	role: "assistant",
	text: "INTERNAL_COMMENTARY",
	timestamp: new Date().toISOString(),
	raw: {
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "INTERNAL_COMMENTARY" },
				{ type: "toolCall", name: "read" },
			],
		},
	},
});
let controller: AbortController | undefined,
	task: Promise<void> | undefined,
	sequence = 0;
const produced: string[] = [];
async function run(text: string, admission: PromptAdmission) {
	controller = new AbortController();
	const signal = controller.signal,
		call = randomUUID(),
		path = join(fixture.root, `result-${++sequence}.txt`),
		input = { path, content: text };
	fixture.native.emit({ type: "agent_start" });
	fixture.native.user(randomUUID(), text);
	admission.disposition("started");
	try {
		execution.begin(call, "write", input);
		const result = await execution.authorize(call, "write", input, signal);
		if (result.allow && !signal.aborted) {
			execution.update(call, {
				content: [{ type: "text", text: "IN_PROGRESS_OUTPUT" }],
			});
			if (text.includes("WAIT"))
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
					if (signal.aborted) resolve();
				});
			if (!signal.aborted) {
				writeFileSync(path, text);
				produced.push(path);
			}
			execution.end(
				call,
				{
					content: [
						{ type: "text", text: signal.aborted ? "cancelled" : "written" },
					],
				},
				signal.aborted,
			);
		} else
			execution.end(
				call,
				{ content: [{ type: "text", text: result.reason ?? "denied" }] },
				true,
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
					content: [
						{
							type: "text",
							text: produced.includes(path) ? "파일 저장 완료" : "작업 중단",
						},
					],
				},
			},
		});
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
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}`,
		root: fixture.root,
		mode,
		nativeAsk,
		providerCalls: 0,
	}),
);
let stopped = false;
const stop = async () => {
	if (stopped) return;
	stopped = true;
	await web.stop(true);
	await backend.stop();
	off();
	await fixture.close();
	execution.close();
	controls.close();
	process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
