import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryFromSnapshot } from "../../../lina-client/src/agent-list.ts";
import { AttachmentStore } from "../../../lina-core/src/attachments/store.ts";
import { handleAttachmentRequest } from "../../../lina-runtime/src/attachment-http.ts";

/** Browser-only fixture: real web assets/gateway, in-memory conversation/task APIs. */

import type { ControlSnapshot } from "../../../lina-core/src/control/types.ts";
import { parseControlClient } from "../../../lina-core/src/control-wire.ts";
import type { SessionSnapshot } from "../../../lina-core/src/protocol.ts";
import { parseWireClient } from "../../../lina-core/src/wire.ts";
import type { TaskDetail } from "../../../lina-ui/client/task-view.ts";
import { loadWebAssets } from "../../src/assets.ts";
import { startWebServer } from "../../src/server.ts";

const timestamp = new Date().toISOString();
const sessionId = randomUUID();
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
const root = mkdtempSync(join(tmpdir(), "lina-ui-desktop-qa-"));
const presentation = process.env["LINA_QA_PRESENTATION"] === "1";
const sampleNames = [
	"Lina",
	"Kai",
	"하루",
	"소담",
	"유리",
	"노아",
	"미오",
	"서우",
	"다온",
	"루카",
];
const count = Number(process.env["LINA_QA_AGENT_COUNT"] ?? 10);
if (!Number.isInteger(count) || count < 1 || count > 50)
	throw new Error("Invalid fixture agent count");
const profiles = Array.from({ length: count }, (_, index) => ({
	id: index === 0 ? "lina" : index === 1 ? "kai" : `agent-${index}`,
	name: presentation
		? (sampleNames[index] ?? `동료 ${index}`)
		: index === 0
			? "Lina"
			: index === 1
				? "Kai"
				: `긴 이름을 가진 에이전트 ${index}`,
	role: index === 0 ? "함께 이야기하는 동료" : "글쓰기와 자료 조사",
	personality: "차분함",
	voice: "편안하게",
	profile: "",
	appearance: "",
	interests: [],
	avatarId: null,
	evolution: "adaptive",
	revision: 1,
	state: "idle",
	dynamics: {
		revision: 0,
		mood: null,
		interests: [],
		preferences: [],
		relationship: [],
		lastRequestId: null,
	},
}));
const snapshots = new Map(
	profiles.map((profile, index) => [
		profile.id,
		{
			...structuredClone(snapshot),
			botId: profile.id,
			state: index === 0 ? "running" : "idle",
			sessionId: index === 0 ? sessionId : randomUUID(),
			messages: Array.from({ length: 32 }, (_, n) => ({
				seq: n + 1,
				entryId: `${profile.id}-entry-${n}`,
				role: n % 2 ? ("assistant" as const) : ("user" as const),
				timestamp,
				truncated: false,
				text:
					`${profile.name}의 대화 ${n + 1}. ` +
					(n % 2
						? "오늘 생각한 내용을 함께 정리해 볼까요? 긴 한글 문장도 자연스럽게 읽을 수 있어요."
						: "이 대화의 맥락과 초안을 다음에도 유지해줘."),
			})),
		} satisfies SessionSnapshot,
	]),
);
// The presentation dataset exercises normal rendering with readable synthetic content.
// Default stress/behavior fixtures above remain unchanged.
if (presentation) {
	const conversation = [
		"이번 주말에는 좀 쉬고 싶어. 반나절 정도만 밖에 다녀올까?",
		"좋아요. 멀리 가기보다, 걷다가 마음에 드는 곳에 잠깐 머무는 주말은 어때요?",
		"성수 쪽이 좋겠어. 너무 빡빡한 일정은 말고.",
		"그럼 두 군데만 정해둘게요. 나머지 시간은 비워두고요.\n\n### 느긋하게 보내는 토요일\n\n- **오전 11시 · 서울숲 산책**\n  천천히 한 바퀴 걸어요. 쉬고 싶으면 벤치에 앉아 있어도 좋고요.\n- **오후 1시 · 점심과 커피**\n  산책을 마치고 골목을 둘러보며 마음에 드는 곳을 골라요.\n\n돌아오는 시간은 정하지 않을게요. 더 걷고 싶으면 걷고, 피곤하면 바로 집으로 가요.",
		"좋다. 챙길 것도 간단히 적어줘.",
		"편한 신발, 물 한 병, 이어폰이면 충분해요. 작은 가방 하나로 가볍게 다녀와요.",
	];
	const previews = [
		"",
		"초안의 첫 문장을 조금 다듬어 봤어요.",
		"내일은 가볍게 20분만 걸어볼까요?",
		"읽고 싶은 책 세 권을 골라봤어요.",
		"여행 준비 목록을 정리했어요.",
		"오늘 들을 음악을 찾아뒀어요.",
		"사진 속 빛이 참 따뜻하네요.",
		"다음 주 일정, 여유 있게 잡아둘게요.",
		"생각나면 언제든 이어서 이야기해요.",
		"저녁은 간단하게 만들어볼까요?",
	];
	for (const [index, profile] of profiles.entries()) {
		const value = snapshots.get(profile.id);
		if (!value) continue;
		const text =
			index === 0
				? conversation
				: [
						"오늘 이야기한 내용 정리해줘.",
						previews[index] ?? "함께 천천히 정리해봐요.",
					];
		value.messages = text.map((content, n) => ({
			seq: n + 1,
			entryId: `${profile.id}-sample-${n}`,
			role: n % 2 ? "assistant" : "user",
			timestamp: new Date(Date.now() - index * 23 * 60_000).toISOString(),
			truncated: false,
			text: content,
		}));
	}
}
const stores = new Map<string, AttachmentStore>(
	profiles.map((profile) => {
		const folder = join(root, profile.id);
		mkdirSync(folder);
		const binding = {
			version: 1 as const,
			botId: profile.id,
			sessionId: snapshots.get(profile.id)?.sessionId ?? sessionId,
			sessionFile: join(folder, "session.jsonl"),
			workspace: folder,
		};
		return [binding.sessionId, new AttachmentStore(folder, binding)] as const;
	}),
);
const persist = () =>
	writeFileSync(
		join(root, "conversations.json"),
		JSON.stringify([...snapshots]),
	);
persist();
const upstream = Bun.serve<{ agentId: string }>({
	hostname: "127.0.0.1",
	port: Number(process.env["LINA_QA_UPSTREAM_PORT"] ?? 18142),
	async fetch(request, server) {
		const path = new URL(request.url).pathname;
		if (
			request.headers.get("upgrade") === "websocket" &&
			server.upgrade(request, {
				data: {
					agentId: new URL(request.url).searchParams.get("agent") ?? "lina",
				},
			})
		)
			return;
		if (path === "/fixture/commands") return Response.json(commands);
		if (path === "/api/onboarding/entry")
			return Response.json({
				firstUser: process.env["LINA_QA_FIRST_USER"] === "1",
				resume: null,
				legacyDrafts: [],
			});
		if (path === "/api/models")
			return Response.json({
				settings: {
					revision: 1,
					profiles: [],
					defaultProfileId: null,
					roles: {},
					agentRoles: {},
				},
				catalog: [],
				active: [],
			});
		if (path === "/api/agents/lina/intro" && request.method === "POST")
			return Response.json({
				room: {
					id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
					agentId: "lina",
					kind: "user",
					status: "active",
					revision: 0,
					mode: "thoughtful",
					draftId: null,
					data: {
						profile: profiles[0],
						chapters: {},
						user: {},
						summary: [],
						ready: false,
					},
					createdAt: Date.now(),
					finalization: null,
				},
				turns: [],
				userRevision: 0,
				shareUser: false,
				presets: [],
				sessionId: null,
			});
		if (path.startsWith("/api/attachments")) {
			const id =
				request.headers.get("X-Lina-Session") ??
				new URL(request.url).searchParams.get("sessionId") ??
				"";
			const store = stores.get(id);
			if (!store) return new Response("Unknown session", { status: 404 });
			return (
				(await handleAttachmentRequest(request, store, store.binding)) ??
				new Response("Not found", { status: 404 })
			);
		}
		if (path === "/api/agents")
			return Response.json({
				agents: profiles,
				presets: [],
				summaries: [...snapshots.values()].map((item) =>
					summaryFromSnapshot(
						item,
						item.botId === "lina" ? control.approvals.length : 0,
					),
				),
			});
		if (/^\/api\/agents\/[^/]+\/intro$/.test(path))
			return Response.json({ room: null });
		if (/^\/api\/agents\/[^/]+$/.test(path)) {
			const profile = profiles.find(
				(item) => item.id === path.split("/").at(-1),
			);
			return Response.json({
				profile,
				dynamics: profile?.dynamics,
				changes: [],
			});
		}
		if (path === "/api/tasks" && request.method === "GET")
			return Response.json({
				tasks:
					!new URL(request.url).searchParams.get("ownerAgentId") ||
					new URL(request.url).searchParams.get("ownerAgentId") ===
						task.task.ownerAgentId
						? [task.task]
						: [],
			});
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
			const snapshot = snapshots.get(socket.data.agentId);
			if (!snapshot) return;
			const text = String(raw);
			const frame = parseWireClient(text) ?? parseControlClient(text);
			if (!frame) return;
			commands.push(frame);
			if (frame.type === "chat") {
				socket.send(JSON.stringify({ type: "ack", id: frame.id }));
				for (const [role, text] of [
					["user", frame.text],
					[
						"assistant",
						"입력과 첨부를 받았어요. 이 응답은 UI 검증용 합성 데이터입니다.",
					],
				] as const)
					snapshot.messages.push({
						seq: snapshot.messages.length + 1,
						entryId: randomUUID(),
						role,
						text,
						timestamp: new Date().toISOString(),
						truncated: false,
					});
				snapshot.state = "idle";
				snapshot.revision++;
				persist();
			}
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
			socket.send(
				JSON.stringify({
					type: "control-state",
					state: {
						...control,
						sessionId: snapshot.sessionId,
						...(snapshot.botId === "lina"
							? {}
							: { approvals: [], tools: [], cancelRequestId: null }),
					},
				}),
			);
			// The real gateway must discard retired frames without affecting conversation.
			socket.send(
				JSON.stringify({ type: "job-error", message: "RETIRED_JOB_ERROR" }),
			);
		},
	},
});
const web = startWebServer({
	port: Number(process.env["LINA_QA_WEB_PORT"] ?? 18140),
	upstream: `ws://127.0.0.1:${upstream.port}`,
	assets: await loadWebAssets(),
});
console.log(
	JSON.stringify({
		url: `http://127.0.0.1:${web.port}/?agent=lina`,
		upstream: upstream.port,
		root,
	}),
);
const stop = () => {
	void Promise.all([web.stop(true), upstream.stop(true)]).then(() =>
		process.exit(0),
	);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
