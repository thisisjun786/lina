import { expect, test } from "bun:test";
import {
	type AgentConversationSummary,
	AgentListModel,
	type AgentListProfile,
	publicMessagePreview,
	summaryFromSnapshot,
} from "../../lina-client/src/agent-list.ts";
import type { SessionSnapshot } from "../../lina-core/src/protocol.ts";

const profiles: AgentListProfile[] = [
	{ id: "lina", name: "Lina", role: "개인 에이전트", avatarId: null },
	{ id: "writer", name: "긴 이름 작가", role: "글쓰기", avatarId: null },
	{ id: "research", name: "Research", role: "자료 조사", avatarId: null },
];
const snapshot = (seq = 2): SessionSnapshot => ({
	version: 2,
	botId: "writer",
	sessionId: "conversation-writer",
	revision: seq,
	state: "idle",
	requests: [],
	hasEarlier: false,
	beforeCursor: 1,
	messages: [
		{
			entryId: `reply-${seq}`,
			seq,
			role: "assistant",
			text: "내일 이어서 이야기해요.",
			timestamp: "2026-09-07T13:18:00Z",
			truncated: false,
		},
	],
});
const summary = (seq = 2): AgentConversationSummary =>
	summaryFromSnapshot(snapshot(seq), 0);

test("selection, summaries and drafts preserve every agent in server order", () => {
	const model = new AgentListModel("writer");
	model.replace(profiles);
	model.updateSummary(summary());
	model.setDraft("research", "새 초안");
	model.setCurrent("research");
	expect(model.rows().map((row) => row.id)).toEqual([
		"lina",
		"writer",
		"research",
	]);
	expect(
		model
			.rows()
			.filter((row) => row.selected)
			.map((row) => row.id),
	).toEqual(["research"]);
	model.setFilter("  글쓰기  ");
	expect(model.rows().map((row) => row.id)).toEqual(["writer"]);
	model.setFilter("RESEARCH");
	expect(model.rows().map((row) => row.id)).toEqual(["research"]);
});

test("confirmation outranks draft, draft outranks message and neither changes message time", () => {
	const model = new AgentListModel("writer");
	model.replace(profiles);
	model.updateSummary({ ...summary(), confirmationCount: 2 });
	model.setDraft("writer", "아직 보내지 않은 말");
	expect(model.rows()[1]?.preview).toBe("확인 필요 · 2건");
	model.setCurrent("writer");
	expect(model.rows()[1]?.confirmationCount).toBe(2);
	model.updateSummary(summary(3));
	expect(model.rows()[1]?.preview).toBe("초안: 아직 보내지 않은 말");
	expect(model.rows()[1]?.timestamp).toBe("2026-09-07T13:18:00Z");
	model.setDraft("writer", "");
	expect(model.rows()[1]?.preview).toBe("내일 이어서 이야기해요.");
});

test("unread requires a visible cursor, survives selection and is separate from confirmation", () => {
	const model = new AgentListModel("writer");
	model.replace(profiles);
	model.updateSummary(summary());
	expect(model.rows()[1]?.unread).toBe(false);
	model.markVisible("writer", "wrong-session", 2);
	model.updateSummary(summary(3));
	expect(model.rows()[1]?.unread).toBe(false);
	model.markVisible("writer", "conversation-writer", 3);
	model.updateSummary({ ...summary(4), confirmationCount: 1 });
	model.setCurrent("writer");
	expect(model.rows()[1]?.unread).toBe(true);
	model.markVisible("writer", "conversation-writer", 999);
	expect(model.rows()[1]?.unread).toBe(true);
	model.markVisible("writer", "conversation-writer", 4);
	expect(model.rows()[1]?.unread).toBe(false);
	expect(model.rows()[1]?.confirmationCount).toBe(1);
});

test("stale revisions do not overwrite public messages; unavailable is not an empty conversation", () => {
	const model = new AgentListModel("writer");
	model.replace(profiles);
	expect(model.rows()[1]?.preview).toBe("대화 요약을 불러오는 중…");
	model.updateSummary(summary(5));
	model.updateSummary(summary(2));
	expect(model.rows()[1]?.messageSequence).toBe(5);
	model.summariesFailed();
	expect(model.rows()[1]?.summaryUnavailable).toBe(true);
	expect(model.rows()[1]?.preview).toBe("내일 이어서 이야기해요.");
	expect(model.rows()[0]?.preview).toBe("대화 요약을 불러오지 못했어요");
});

test("snapshot projection excludes tool/meta text and does not label missing approvals as zero", () => {
	const value = snapshot();
	value.messages.push({
		...{
			entryId: "tool",
			text: "",
			timestamp: "2026-09-07T00:00:00Z",
			truncated: false,
		},
		seq: 99,
		role: "tool",
		text: "INTERNAL SECRET",
	});
	const result = summaryFromSnapshot(value);
	expect(result.latestMessage?.seq).toBe(2);
	expect(result.confirmationCount).toBeNull();
	expect(publicMessagePreview({ role: "user", text: "내일\n봐요" })).toBe(
		"나: 내일 봐요",
	);
	expect(
		publicMessagePreview({ role: "assistant", text: "```ts\nconst x=1\n```" }),
	).toBe("코드 답변");
	expect(
		publicMessagePreview({
			role: "user",
			text: "[보고서.pdf](/api/attachments/11111111-1111-1111-1111-111111111111?sessionId=22222222-2222-2222-2222-222222222222)",
		}),
	).toBe("나: 보고서.pdf");
});

test("GET agents reads persisted public summaries after restart without opening an engine", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } =
		await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { DurableStore } = await import("../../lina-core/src/store.ts");
	const { AgentFleet } = await import(
		"../../lina-runtime/src/fleet/manager.ts"
	);
	const { startFleetServer } = await import(
		"../../lina-runtime/src/fleet/server.ts"
	);
	const root = mkdtempSync(join(tmpdir(), "lina-list-test-"));
	let opened = 0;
	const fleet = new AgentFleet({
		workspace: root,
		resourceRoot: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: async () => {
			opened++;
			throw Error("must not open");
		},
	});
	const primary = fleet.presets.find((profile) => profile.id === "lina");
	if (!primary) throw Error("Missing primary");
	fleet.agents.create({ ...primary, id: "writer", name: "Writer" });
	fleet.agents.create({ ...primary, id: "unopened", name: "Unopened" });
	const writerRoot = join(root, "agents", "writer");
	mkdirSync(writerRoot, { recursive: true });
	const binding = {
		version: 1 as const,
		botId: "writer",
		sessionId: "writer-session",
		sessionFile: join(writerRoot, "session.jsonl"),
		workspace: root,
	};
	writeFileSync(join(writerRoot, "binding.json"), JSON.stringify(binding));
	const path = join(writerRoot, "state.sqlite");
	const store = new DurableStore(path, binding);
	store.appendEntry({
		entryId: "public",
		role: "assistant",
		text: "확정된 답변",
		timestamp: "2026-09-07T13:18:00Z",
		raw: { message: { phase: "final_answer" } },
	});
	store.appendEntry({
		entryId: "commentary",
		role: "assistant",
		text: "PRIVATE COMMENTARY",
		timestamp: "2026-09-07T13:19:00Z",
		raw: { message: { phase: "commentary" } },
	});
	store.appendEntry({
		entryId: "tool",
		role: "tool",
		text: "PRIVATE TOOL",
		timestamp: "2026-09-07T13:20:00Z",
		raw: {},
	});
	store.close();
	// Finalize the fixture WAL before comparing file bytes; the reader cannot checkpoint it.
	const { DatabaseSync } = await import("node:sqlite");
	const checkpoint = new DatabaseSync(path);
	checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	checkpoint.close();
	const original = readFileSync(path);
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	try {
		const response = await fetch(`http://127.0.0.1:${server.port}/api/agents`);
		const data = (await response.json()) as {
			agents: { id: string }[];
			summaries: AgentConversationSummary[];
		};
		expect(response.status).toBe(200);
		expect(data.summaries?.map((item) => item.agentId)).toEqual(
			data.agents.map((item) => item.id),
		);
		const writer = data.summaries.find((item) => item.agentId === "writer");
		expect(writer?.latestMessage).toMatchObject({
			entryId: "public",
			text: "확정된 답변",
			timestamp: "2026-09-07T13:18:00Z",
			seq: 1,
		});
		expect(writer?.confirmationCount).toBeNull();
		expect(writer?.running).toBeNull();
		expect(
			data.summaries.find((item) => item.agentId === "unopened")?.available,
		).toBe(true);
		expect(JSON.stringify(data)).not.toContain("PRIVATE");
		expect(opened).toBe(0);
		expect(readFileSync(path)).toEqual(original);
		writeFileSync(
			join(writerRoot, "binding.json"),
			JSON.stringify({ ...binding, botId: "foreign" }),
		);
		const failed = (await fetch(
			`http://127.0.0.1:${server.port}/api/agents`,
		).then((result) => result.json())) as typeof data;
		expect(
			failed.summaries.find((item) => item.agentId === "writer")?.available,
		).toBe(false);
		expect(JSON.stringify(failed.summaries)).not.toContain("확정된 답변");
		expect(
			(
				await fetch(`http://127.0.0.1:${server.port}/api/agents`, {
					headers: { origin: "https://foreign.invalid" },
				})
			).status,
		).toBe(403);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("visible cursors persist per agent and session while storage failure stays usable", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	const first = new AgentListModel("writer", storage);
	first.replace(profiles);
	first.updateSummary(summary(3));
	first.markVisible("writer", "conversation-writer", 3);
	const restored = new AgentListModel("writer", storage);
	restored.replace(profiles);
	restored.updateSummary(summary(4));
	expect(restored.rows()[1]?.unread).toBe(true);
	restored.updateSummary({ ...summary(5), sessionId: "new-conversation" });
	expect(restored.rows()[1]?.unread).toBe(false);
	const blocked = new AgentListModel("writer", {
		getItem: () => {
			throw Error("blocked");
		},
		setItem: () => {
			throw Error("blocked");
		},
	});
	blocked.replace(profiles);
	blocked.updateSummary(summary(4));
	blocked.markVisible("writer", "conversation-writer", 4);
	blocked.updateSummary(summary(5));
	expect(blocked.rows()[1]?.unread).toBe(true);
});

test("a user's own message does not become an unread assistant reply", () => {
	const model = new AgentListModel("writer");
	model.replace(profiles);
	model.updateSummary(summary(2));
	model.markVisible("writer", "conversation-writer", 2);
	const value = snapshot(3);
	value.messages = [
		{
			entryId: "own",
			seq: 3,
			role: "user",
			text: "내가 보낸 말",
			timestamp: "2026-09-07T13:18:00Z",
			truncated: false,
		},
	];
	model.updateSummary(summaryFromSnapshot(value, 0));
	expect(model.rows()[1]?.unread).toBe(false);
	expect(model.rows()[1]?.preview).toBe("나: 내가 보낸 말");
});
