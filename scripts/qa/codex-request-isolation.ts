import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedCodexRpc } from "../../packages/lina-runtime/src/fleet/shared-codex-rpc.ts";
import { createTaskTransport } from "../../packages/lina-runtime/src/fleet/task-transport.ts";

const root = mkdtempSync(join(tmpdir(), "lina-request-isolation-"));
const path =
	process.env["LINA_CODEX_SOCKET"] ??
	join(
		process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
		"app-server-control/app-server-control.sock",
	);
const observer = await createSharedCodexRpc(path);
const observed: string[] = [];
observer.onRequest(async (method) => {
	observed.push(method);
});
const transport = createTaskTransport(
	async () => observer,
	() => false,
);
const owner = await createSharedCodexRpc(path);
let threadId: string | undefined;
let toolCalls = 0;
const records: unknown[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	await transport.request("model/list", {});
	await owner.request("initialize", {
		clientInfo: { name: "lina-isolation-owner", version: "1.0" },
		capabilities: { experimentalApi: true },
	});
	owner.notify("initialized");
	owner.onRequest(async (method) => {
		if (method !== "item/tool/call") throw Error("unexpected native request");
		toolCalls++;
		return {
			contentItems: [{ type: "inputText", text: "LINA_TOOL_ISOLATION_OK" }],
			success: true,
		};
	});
	const created = await owner.request<{ thread: { id: string } }>(
		"thread/start",
		{
			cwd: root,
			model: "gpt-5.6-sol",
			approvalPolicy: "on-request",
			sandbox: "read-only",
			baseInstructions:
				"Synthetic transport check. Call lina_isolation_probe exactly once, then repeat its returned text. No other tools.",
			dynamicTools: [
				{
					type: "function",
					name: "lina_isolation_probe",
					description: "Return the isolated QA marker",
					inputSchema: {
						type: "object",
						properties: {},
						additionalProperties: false,
					},
				},
			],
		},
	);
	threadId = created.thread.id;
	const done = new Promise<void>((resolve, reject) => {
		timer = setTimeout(() => reject(Error("isolation probe timeout")), 60000);
		owner.subscribe((method, params) => {
			if (
				method === "turn/completed" &&
				(params as { threadId?: string })?.threadId === threadId
			) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	await owner.request("turn/start", {
		threadId,
		model: "gpt-5.6-sol",
		input: [
			{
				type: "text",
				text: "Call lina_isolation_probe once and return its marker.",
				text_elements: [],
			},
		],
	});
	await done;
	const state = await owner.request<unknown>("thread/read", {
		threadId,
		includeTurns: true,
	});
	assert.equal(toolCalls, 1);
	assert.deepEqual(observed, []);
	assert.ok(JSON.stringify(state).includes("LINA_TOOL_ISOLATION_OK"));
	records.push({
		sameDaemon: true,
		unrelatedLinaClientRequests: observed,
		ownerToolCalls: toolCalls,
		markerReturned: true,
		threadId,
	});
} catch (error) {
	records.push({
		error: error instanceof Error ? error.message : String(error),
		observed,
		toolCalls,
	});
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	if (threadId) await owner.request("thread/archive", { threadId });
	await owner.close();
	await transport.close();
	rmSync(root, { recursive: true, force: true });
	records.push({
		teardown:
			"owned connections closed; probe archived; temp root removed; shared daemon untouched",
	});
	await Bun.write(
		new URL(
			"../../devlog/_plan/260906_codex_runtime/094_request_isolation.json",
			import.meta.url,
		),
		JSON.stringify(records, null, 2) + "\n",
	);
	console.log(JSON.stringify(records));
}
