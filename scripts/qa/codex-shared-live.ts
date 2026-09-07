import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexRpc } from "../../packages/lina-codex/src/rpc.ts";
import { TaskManager } from "../../packages/lina-codex/src/tasks.ts";
import { createSharedCodexRpc } from "../../packages/lina-runtime/src/fleet/shared-codex-rpc.ts";
import { createTaskTransport } from "../../packages/lina-runtime/src/fleet/task-transport.ts";

const root = mkdtempSync(join(tmpdir(), "lina-shared-probe-"));
const cwd = join(root, "work");
mkdirSync(cwd);
const socket =
	process.env["LINA_CODEX_SOCKET"] ??
	join(
		process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
		"app-server-control",
		"app-server-control.sock",
	);
const transport = createTaskTransport(() => createSharedCodexRpc(socket));
const tasks = new TaskManager({
	path: join(root, "tasks.sqlite"),
	rpc: transport,
});
let second: CodexRpc | undefined;
let threadId: string | undefined;
const records: unknown[] = [{ step: "state", root }];
async function idle(id: string, expectedTurn?: string) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(Error("shared task did not settle"));
		}, 45000);
		const check = () => {
			void tasks.read(id).then(
				(value) => {
					if (
						value.task.status === "idle" &&
						(!expectedTurn ||
							value.thread?.turns?.some(
								(turn) =>
									turn.id === expectedTurn && turn.status !== "inProgress",
							))
					) {
						clearTimeout(timer);
						off();
						resolve();
					}
				},
				(error) => {
					clearTimeout(timer);
					off();
					reject(error);
				},
			);
		};
		const off = tasks.subscribe((event) => {
			if (event.task.id === id) check();
		});
		check();
	});
}
try {
	const created = await tasks.create({
		ownerAgentId: "lina",
		title: "LINA isolated shared-engine verification",
		cwd,
		prompt:
			"Synthetic integration check only. Do not use tools or modify files. Reply exactly LINA_SHARED_OK.",
		requestId: randomUUID(),
		model: "gpt-5.6-sol",
	});
	if (!created.threadId) throw Error("No shared native task id");
	threadId = created.threadId;
	await idle(created.id);
	const initial = await tasks.read(created.id);
	assert.equal(initial.task.source, "lina");
	assert.ok(JSON.stringify(initial.thread).includes("LINA_SHARED_OK"));
	records.push({ step: "created", task: initial });
	second = await createSharedCodexRpc(socket);
	await second.request("initialize", {
		clientInfo: { name: "lina-direct-user-probe", version: "1.0" },
		capabilities: { experimentalApi: true },
	});
	second.notify("initialized");
	const read = await second.request<{ thread: { id: string } }>("thread/read", {
		threadId,
		includeTurns: true,
	});
	assert.equal(read.thread.id, threadId);
	records.push({ step: "second-client-read", sameThread: true });
	await second.request("thread/resume", { threadId });
	const direct = await second.request<{ turn: { id: string } }>("turn/start", {
		threadId,
		input: [
			{
				type: "text",
				text: "Direct user intervention check. Do not use tools. Reply exactly LINA_DIRECT_OK.",
				text_elements: [],
			},
		],
		clientUserMessageId: randomUUID(),
		model: "gpt-5.6-sol",
	});
	await idle(created.id, direct.turn.id);
	const external = await tasks.read(created.id);
	assert.equal(external.task.source, "external");
	assert.ok(JSON.stringify(external.thread).includes("LINA_DIRECT_OK"));
	records.push({ step: "external-reconciled", task: external });
	const handed = await tasks.handover(created.id, {
		ownerAgentId: "kai",
		expectedRevision: external.task.revision,
	});
	assert.equal(handed.threadId, threadId);
	assert.equal(handed.ownerAgentId, "kai");
	records.push({ step: "handover", task: handed, sameThread: true });
} catch (error) {
	records.push({
		step: "error",
		message: error instanceof Error ? error.message : "unknown",
	});
	process.exitCode = 1;
} finally {
	if (threadId) {
		try {
			await transport.request("thread/archive", { threadId });
			records.push({ step: "archive-owned-probe", threadId });
		} catch (error) {
			records.push({
				step: "archive-error",
				message: error instanceof Error ? error.message : "unknown",
			});
		}
	}
	await tasks.close();
	await second?.close();
	await transport.close();
	records.push({
		step: "teardown",
		ownedConnectionsClosed: true,
		sharedDaemonUntouched: true,
	});
	await Bun.write(
		new URL(
			"../../devlog/_plan/260906_codex_runtime/056_shared_live.json",
			import.meta.url,
		),
		JSON.stringify(records, null, 2) + "\n",
	);
	console.log(
		JSON.stringify(
			records.map((r) => {
				const v = r as Record<string, unknown>;
				return v["task"] ? { step: v["step"], taskRecorded: true } : r;
			}),
		),
	);
}
