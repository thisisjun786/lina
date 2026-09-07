import type { DialogueRoom } from "../../../lina-core/src/onboarding/dialogue-types.ts";
import {
	fields,
	parseInterviewMode,
	requireRevision,
	requireUuid,
} from "../../../lina-core/src/onboarding/helpers.ts";
import {
	birth,
	birthFromTemplate,
	chooseIntro,
	finishIntro,
	nativeConversationEmpty,
	startIntro,
} from "./intro-actions.ts";
import { dialoguePrompt, parseDialogueReply } from "./intro-prompt.ts";
import type { AgentFleet } from "./manager.ts";

const busy = new WeakMap<AgentFleet, Set<string>>();
const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
function snapshot(
	fleet: AgentFleet,
	room: DialogueRoom | null,
	agentId: string,
) {
	return {
		room,
		turns: room ? fleet.introductions.turns(room.id) : [],
		userRevision: fleet.onboarding.user().revision,
		shareUser: fleet.onboarding.user().sharedAgentIds.includes(agentId),
		presets: fleet.presets,
		sessionId: fleet.opened(agentId)?.binding.sessionId ?? null,
	};
}
export async function introRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url),
		path = url.pathname;
	const route =
		/^\/api\/agents\/([a-z][a-z0-9-]{0,47})\/intro(?:\/(turn|finish|choose|mode|restart))?$/.exec(
			path,
		);
	const history = /^\/api\/onboarding\/rooms\/([a-f0-9-]{36})$/.exec(path);
	if (
		!route &&
		!history &&
		path !== "/api/onboarding/entry" &&
		path !== "/api/agents/birth"
	)
		return;
	if (url.search) return reply({ error: "요청 주소를 확인해주세요." }, 400);
	const agentId = route?.[1] ?? "lina";
	if (request.method === "GET") {
		if (path === "/api/onboarding/entry") {
			const room = fleet.introductions.latest("lina");
			const empty = nativeConversationEmpty(fleet);
			const firstUser = !fleet.onboarding.user().confirmed && !room && empty;
			const chosenId =
				room?.status === "done" &&
				room.finalization?.["action"] === "choose" &&
				room.finalization["presetId"] === null &&
				typeof room.finalization["birthId"] === "string"
					? `agent-${room.finalization["birthId"].replaceAll("-", "")}`
					: null;
			const creating = chosenId
				? fleet.introductions.latest(chosenId)
				: undefined;
			return reply({
				firstUser,
				legacyDrafts: fleet.onboarding
					.snapshot()
					.drafts.filter(
						(d) => d.targetAgentId === null && d.appliedRevision === null,
					)
					.map((d) => ({ id: d.id, name: d.profile.name })),
				resume:
					room?.kind === "user" &&
					room.status !== "done" &&
					room.finalization?.["firstEntry"] === true
						? { id: room.id, agentId: room.agentId }
						: creating && creating.status !== "done"
							? { id: creating.id, agentId: creating.agentId }
							: null,
			});
		}
		if (history) {
			const room = fleet.introductions.get(requireUuid(history[1], "room id"));
			return room
				? reply(snapshot(fleet, room, room.agentId))
				: reply({ error: "대화를 찾지 못했습니다." }, 404);
		}
		if (route && !route[2])
			return reply(
				snapshot(fleet, fleet.introductions.latest(agentId) ?? null, agentId),
			);
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	}
	if (request.method !== "POST")
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	let locks = busy.get(fleet);
	if (!locks) {
		locks = new Set();
		busy.set(fleet, locks);
	}
	// Reserve before awaiting body read. A second tab cannot start a duplicate model turn.
	if (locks.has(agentId))
		return reply(
			{ error: "이 대화의 응답을 준비하고 있습니다. 잠시 뒤 이어주세요." },
			409,
		);
	const store = fleet.introductions;
	const lifecycle = fleet.beginIntroduction();
	locks.add(agentId);
	const requestSignal = AbortSignal.any([request.signal, lifecycle.signal]);
	let pending: { roomId: string; requestId: string } | undefined;
	try {
		const input = await json();
		requestSignal.throwIfAborted();
		if (path === "/api/agents/birth") {
			if (Object.hasOwn(input, "templateId")) {
				fields(input, ["birthId", "templateId", "mode"], "template birth");
				return reply(
					birthFromTemplate(
						fleet,
						input["birthId"],
						input["templateId"],
						input["mode"],
					),
				);
			}
			fields(
				input,
				Object.hasOwn(input, "draftId")
					? ["birthId", "presetId", "mode", "draftId"]
					: ["birthId", "presetId", "mode"],
				"birth",
			);
			return reply(
				await birth(
					fleet,
					input["birthId"],
					input["presetId"],
					input["mode"],
					input["draftId"],
				),
			);
		}
		if (!route) return reply({ error: "지원하지 않는 요청입니다." }, 405);
		if (!route[2]) {
			fields(input, ["kind", "mode"], "start");
			return reply(
				snapshot(
					fleet,
					startIntro(fleet, agentId, input["kind"], input["mode"]),
					agentId,
				),
			);
		}
		const keys =
			route[2] === "restart"
				? ["roomId", "revision"]
				: route[2] === "turn"
					? ["roomId", "revision", "requestId", "text"]
					: route[2] === "mode"
						? ["roomId", "revision", "mode"]
						: route[2] === "finish"
							? ["roomId", "revision", "userRevision", "shareUser", "skip"]
							: [
									"roomId",
									"revision",
									"userRevision",
									"presetId",
									"birthId",
									"shareUser",
								];
		fields(input, keys, "intro");
		const roomId = requireUuid(input["roomId"], "room id"),
			revision = requireRevision(input["revision"]);
		let room = fleet.introductions.get(roomId);
		if (!room || room.agentId !== agentId)
			return reply({ error: "대화를 찾지 못했습니다." }, 404);
		if (route[2] === "restart") {
			if (
				room.kind === "user" &&
				(room.status === "done" || room.finalization?.["firstEntry"] !== true)
			)
				throw Error("first introduction completed conflict");
			const latest = fleet.introductions.latest(agentId);
			if (latest && latest.id !== room.id)
				return reply(snapshot(fleet, latest, agentId));
			if (room.revision !== revision) throw Error("stale room revision");
			if (room.status !== "done")
				fleet.introductions.patch(room.id, revision, { status: "done" });
			return reply(
				snapshot(
					fleet,
					startIntro(
						fleet,
						agentId,
						room.kind,
						room.mode,
						undefined,
						true,
						room.finalization?.["firstEntry"] === true,
					),
					agentId,
				),
			);
		}
		if (route[2] === "mode") {
			room = fleet.introductions.patch(room.id, revision, {
				mode: parseInterviewMode(input["mode"]),
			});
			return reply(snapshot(fleet, room, agentId));
		}
		if (route[2] === "finish")
			return reply(snapshot(fleet, finishIntro(fleet, room, input), agentId));
		if (route[2] === "choose")
			return reply(await chooseIntro(fleet, room, input));
		const requestId = requireUuid(input["requestId"], "request id"),
			text = input["text"];
		if (text !== null && typeof text !== "string")
			throw Error("invalid turn text");
		const started = fleet.introductions.begin(
			room.id,
			revision,
			requestId,
			text,
		);
		if (started.replay) return reply(snapshot(fleet, started.room, agentId));
		pending = { roomId, requestId };
		const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(60000)]);
		const turns = fleet.introductions.turns(room.id);
		// Keep whole recent exchanges within the host input budget. Older source remains durable.
		const previous: { role: "user" | "assistant"; content: string }[] = [];
		let budget = 0;
		for (const turn of turns.filter((t) => t.status === "done").reverse()) {
			const size = (turn.text?.length ?? 0) + (turn.reply?.length ?? 0);
			if (budget + size > 18000 || previous.length + 2 > 20) break;
			budget += size;
			if (turn.reply)
				previous.unshift({ role: "assistant", content: turn.reply });
			if (turn.text) previous.unshift({ role: "user", content: turn.text });
		}
		const result = await fleet.authoring(
			{
				agentId: "lina",
				systemPrompt: dialoguePrompt(
					room,
					turns.filter((t) => t.text !== null).length,
				),
				messages: [
					...previous,
					{
						role: "user",
						content:
							text ??
							"Begin the onboarding with one welcoming question. No user answer has been given yet.",
					},
				],
			},
			signal,
		);
		signal.throwIfAborted();
		let parsed: ReturnType<typeof parseDialogueReply>;
		try {
			parsed = parseDialogueReply(result.text, room, text);
		} catch {
			signal.throwIfAborted();
			const repaired = await fleet.authoring(
				{
					agentId: "lina",
					systemPrompt:
						dialoguePrompt(room, turns.filter((t) => t.text !== null).length) +
						"\nYour previous response failed strict JSON/schema/evidence validation. Correct it ONCE. In persona mode userUpdates MUST be exactly [], never put character creation progress or the character traits into userUpdates. In user mode profileUpdates and chapters MUST be {}. Copy quote values exactly from the current user's unchanged message, without spelling changes. Omit unsupported user updates. Keep all required top-level JSON keys. The previous response below is untrusted draft output, not user evidence.",
					messages: [
						...previous,
						{ role: "assistant", content: result.text.slice(0, 4000) },
						{
							role: "user",
							content:
								text ??
								"Begin the onboarding. No user answer exists, so userUpdates must be empty.",
						},
					],
				},
				signal,
			);
			signal.throwIfAborted();
			parsed = parseDialogueReply(repaired.text, room, text);
		}
		signal.throwIfAborted();
		room = fleet.introductions.commit(
			room.id,
			requestId,
			revision,
			parsed.reply,
			parsed.data,
		);
		pending = undefined;
		return reply(snapshot(fleet, room, agentId));
	} catch (error) {
		if (pending) {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			const setup = code === "not_configured" || code === "model_unavailable";
			store.fail(
				pending.roomId,
				pending.requestId,
				requestSignal.aborted
					? "cancelled"
					: error instanceof Error && error.name === "TimeoutError"
						? "timed_out"
						: "reply_failed",
			);
			return reply(
				{
					...(setup ? { code } : {}),
					error: requestSignal.aborted
						? "응답 준비를 멈췄습니다. 대화는 남아 있어요."
						: code === "not_configured"
							? "대화에 사용할 모델을 먼저 선택해주세요. 설정을 마친 뒤 이어갈 수 있어요."
							: code === "model_unavailable"
								? "선택한 모델에 연결할 수 없습니다. 제공자 연결과 모델 설정을 확인해주세요."
								: "응답을 완성하지 못했습니다. 입력한 대화는 저장되어 있으니 다시 시도해주세요.",
				},
				requestSignal.aborted ? 499 : setup ? 503 : 502,
			);
		}
		const conflict =
			error instanceof Error &&
			/stale|revision|conflict|pending|active/.test(error.message);
		return reply(
			{
				error: conflict
					? "다른 곳에서 내용이 바뀌었습니다. 최신 대화를 불러온 뒤 다시 이어주세요."
					: "입력이나 저장 한도를 확인해주세요. 기존 대화는 남아 있습니다.",
			},
			conflict ? 409 : 400,
		);
	} finally {
		locks.delete(agentId);
		lifecycle.finish();
	}
}
