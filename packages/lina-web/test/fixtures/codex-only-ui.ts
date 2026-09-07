/** Browser-only fixture: real web assets/gateway, in-memory conversation/task APIs. */

import type { ControlSnapshot } from "../../../lina-core/src/control/types.ts";
import { parseControlClient } from "../../../lina-core/src/control-wire.ts";
import type { SessionSnapshot } from "../../../lina-core/src/protocol.ts";
import { parseWireClient } from "../../../lina-core/src/wire.ts";
import type { TaskDetail } from "../../client/task-view.ts";
import { loadWebAssets } from "../../src/assets.ts";
import { startWebServer } from "../../src/server.ts";

const timestamp = new Date().toISOString();
const sessionId = "synthetic-conversation";
const snapshot: SessionSnapshot = {
	version: 2,
	botId: "lina",
	sessionId,
	revision: 1,
	state: "running",
	hasEarlier: false,
	beforeCursor: null,
	requests: [],
	messages: [
		{
			seq: 1,
			entryId: "user-1",
			role: "user",
			timestamp,
			truncated: false,
			text: "로그인 흐름을 확인하고, 변경 전에 알려줘.",
		},
		{
			seq: 2,
			entryId: "assistant-1",
			role: "assistant",
			timestamp,
			truncated: false,
			text: "로그인 오류를 확인했어요. 수정 내용을 검증하기 전에 승인을 기다리고 있어요.",
		},
	],
};
const inputJson = JSON.stringify({ command: "bun test" });
const control: ControlSnapshot = {
	sessionId,
	revision: 1,
	cancelRequestId: "request-1",
	cancelling: false,
	cancelFailed: false,
	tools: [
		{
			id: "tool-1",
			nativeCallId: "native-1",
			requestId: "request-1",
			name: "bash",
			state: "waiting_approval",
			inputPreview: inputJson,
			outputPreview: "",
			createdAt: timestamp,
			updatedAt: timestamp,
		},
	],
	approvals: [
		{
			id: "approval-1",
			toolRunId: "tool-1",
			inputDigest: "a".repeat(64),
			inputJson,
			state: "pending",
			expiresAt: Date.now() + 3_600_000,
			createdAt: timestamp,
		},
	],
};
const task: TaskDetail = {
	task: {
		id: "task-1",
		threadId: "thread-1",
		ownerAgentId: "lina",
		title: "로그인 오류와 긴 안내 문구 확인",
		cwd: "/synthetic/workspace",
		status: "waiting_approval",
		revision: 1,
		updatedAt: timestamp,
		model: "synthetic-model",
		pendingApprovals: [
			{
				id: "task-approval",
				method: "item/commandExecution/requestApproval",
				params: { command: "bun test", cwd: "/synthetic/workspace" },
				createdAt: timestamp,
			},
		],
	},
	thread: {
		id: "thread-1",
		turns: [
			{
				id: "turn-1",
				status: "inProgress",
				error: null,
				items: [
					{
						type: "userMessage",
						content: [{ type: "text", text: "로그인 오류를 확인해줘." }],
					},
					{
						type: "agentMessage",
						text: "입력 검증을 확인했습니다. 테스트 실행은 승인을 기다립니다.",
					},
				],
			},
		],
	},
};
const commands: unknown[] = [];
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (
			request.headers.get("upgrade") === "websocket" &&
			server.upgrade(request)
		)
			return;
		if (path === "/fixture/commands") return Response.json(commands);
		if (path === "/api/onboarding/entry")
			return Response.json({
				firstUser: false,
				resume: null,
				legacyDrafts: [],
			});
		if (path === "/api/agents")
			return Response.json({
				agents: [
					{
						id: "lina",
						name: "Lina",
						role: "함께 이야기하는 동료",
						state: "running",
					},
					{ id: "kai", name: "Kai", role: "개발 동료", state: "idle" },
				],
				presets: [],
			});
		if (path === "/api/tasks" && request.method === "GET")
			return Response.json({ tasks: [task.task] });
		if (path === "/api/tasks/task-1" && request.method === "GET")
			return Response.json(task);
		if (path.startsWith("/api/tasks") && request.method === "POST") {
			const body = (await request.json()) as Record<string, unknown>;
			commands.push({ path, body });
			if (body["expectedRevision"] !== task.task.revision)
				return Response.json(
					{ error: "작업이 변경되었습니다." },
					{ status: 409 },
				);
			if (path.endsWith("/messages"))
				return Response.json(
					{ error: "연결을 확인하고 다시 보내주세요." },
					{ status: 503 },
				);
			if (path.endsWith("/approval")) {
				task.task.pendingApprovals = [];
				task.task.status = "inProgress";
			}
			if (path.endsWith("/interrupt")) task.task.status = "interrupted";
			if (path.endsWith("/owner"))
				task.task.ownerAgentId = String(body["ownerAgentId"]);
			task.task.revision++;
			return Response.json(task);
		}
		return Response.json(
			{ error: "Synthetic fixture has no such route." },
			{ status: 404 },
		);
	},
	websocket: {
		open(socket) {
			socket.send(JSON.stringify({ type: "agent-status", state: "running" }));
		},
		message(socket, raw) {
			const text = String(raw);
			const frame = parseWireClient(text) ?? parseControlClient(text);
			if (!frame) return;
			commands.push(frame);
			if (frame.type === "ping") {
				socket.send(JSON.stringify({ ...frame, type: "pong" }));
				return;
			}
			if (frame.type === "approval_reply" || frame.type === "cancel") {
				control.approvals = [];
				control.tools = [];
				control.cancelRequestId = null;
				control.revision++;
				snapshot.state = "idle";
				snapshot.revision++;
			}
			socket.send(JSON.stringify({ type: "snapshot", snapshot }));
			socket.send(JSON.stringify({ type: "control-state", state: control }));
			// The real gateway must discard retired frames without affecting conversation.
			socket.send(
				JSON.stringify({ type: "job-error", message: "RETIRED_JOB_ERROR" }),
			);
		},
	},
});
const web = startWebServer({
	port: 0,
	upstream: `ws://127.0.0.1:${upstream.port}`,
	assets: await loadWebAssets(),
});
console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}/?agent=lina`,
		upstream: upstream.port,
	}),
);
const stop = () => {
	void Promise.all([web.stop(true), upstream.stop(true)]).then(() =>
		process.exit(0),
	);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
