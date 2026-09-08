import { unionLearnedProofs } from "../../../lina-core/src/agents/learned-provenance.ts";
import { composePersonaPrompt } from "../../../lina-core/src/agents/persona.ts";
import { emptyDynamics } from "../../../lina-core/src/agents/validation.ts";
import {
	fields,
	parseChapterId,
	requireRevision,
	requireUuid,
} from "../../../lina-core/src/onboarding/helpers.ts";
import {
	buildInterviewUserMessage,
	formatAuthoredExtension,
	formatUserContext,
	INTERVIEW_SYSTEM_PROMPT,
	PREVIEW_NOTICE,
} from "../../../lina-core/src/onboarding/prompt.ts";
import type {
	AddAnswerInput,
	AgentDraft,
	ApplyRequest,
	CreateDraftInput,
	PatchDraftInput,
	PreviewMessage,
	SaveUserInput,
} from "../../../lina-core/src/onboarding/types.ts";
import {
	CHAPTERS,
	MAX_AUTOMATIC_FOLLOWUPS,
} from "../../../lina-core/src/onboarding/types.ts";
import { sourceProofsCurrent } from "../../../lina-core/src/source-policy.ts";
import { ModelRequestError } from "../models/errors.ts";
import {
	defaultConversation,
	preferenceInstructions,
} from "../persona/conversation.ts";
import type { AgentFleet } from "./manager.ts";

const busy = new WeakSet<AgentFleet>();
const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
function bool(value: unknown): boolean {
	if (typeof value !== "boolean") throw Error("invalid boolean");
	return value;
}
function messages(value: unknown): PreviewMessage[] {
	if (!Array.isArray(value) || !value.length || value.length > 12)
		throw Error("invalid preview messages");
	let chars = 0;
	const result = value.map((item: unknown): PreviewMessage => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw Error("invalid message");
		const m = item as Record<string, unknown>;
		fields(m, ["role", "content"], "message");
		if (
			(m["role"] !== "user" && m["role"] !== "assistant") ||
			typeof m["content"] !== "string" ||
			!m["content"].trim() ||
			m["content"].includes("\0")
		)
			throw Error("invalid message");
		chars += m["content"].length;
		return { role: m["role"], content: m["content"] };
	});
	if (chars > 12000 || result.at(-1)?.role !== "user")
		throw Error("invalid preview budget");
	return result;
}
async function model(
	fleet: AgentFleet,
	input: Parameters<AgentFleet["authoring"]>[0],
	signal: AbortSignal,
) {
	try {
		const result = await fleet.authoring(input, signal);
		signal.throwIfAborted();
		return result;
	} catch (error) {
		if (signal.aborted) signal.throwIfAborted();
		if (error instanceof ModelRequestError) throw error;
		throw new ModelRequestError(
			"모델 응답을 받지 못했습니다. 저장된 답변으로 다시 시도할 수 있습니다.",
		);
	}
}
export async function onboardingRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/api/onboarding")) return;
	if (url.search) return reply({ error: "요청 주소를 확인해주세요." }, 400);
	const path = url.pathname;
	const store = fleet.onboarding;
	try {
		if (path === "/api/onboarding" && request.method === "GET")
			return reply(store.snapshot());
		if (path === "/api/onboarding/user" && request.method === "PATCH") {
			const input = await json();
			fields(
				input,
				["revision", "answers", "sharedAgentIds", "confirm"],
				"user",
			);
			return reply(
				store.saveUser(
					input as SaveUserInput,
					new Set(fleet.agents.list().map((a) => a.id)),
				),
			);
		}
		if (path === "/api/onboarding/drafts" && request.method === "POST") {
			const input = await json();
			if (
				Object.keys(input).some(
					(k) => !["targetAgentId", "presetId", "mode"].includes(k),
				)
			)
				throw Error("invalid draft fields");
			return reply(
				store.createDraft(input as CreateDraftInput, {
					agents: fleet.agents,
					presets: fleet.presets,
					existingCount: fleet.agents.list().length,
				}),
				201,
			);
		}
		const draftRoute =
			/^\/api\/onboarding\/drafts\/([a-f0-9-]{36})(?:\/(answer|apply))?$/.exec(
				path,
			);
		if (draftRoute) {
			const id = requireUuid(draftRoute[1], "draft id");
			if (!store.getDraft(id))
				return reply({ error: "초안을 찾지 못했습니다." }, 404);
			const input = await json();
			if (!draftRoute[2] && request.method === "PATCH")
				return reply(store.patchDraft(id, input as PatchDraftInput));
			if (draftRoute[2] === "answer" && request.method === "POST")
				return reply(store.addAnswer(id, input as AddAnswerInput));
			if (draftRoute[2] === "apply" && request.method === "POST")
				return reply(store.applyDraft(id, input as ApplyRequest, fleet.agents));
		}
		if (
			(path === "/api/onboarding/interview" ||
				path === "/api/onboarding/preview") &&
			request.method === "POST"
		) {
			if (busy.has(fleet))
				return reply(
					{ error: "다른 인터뷰나 미리보기 응답을 준비하고 있습니다." },
					429,
				);
			busy.add(fleet);
			try {
				const input = await json();
				const interview = path.endsWith("/interview");
				fields(
					input,
					interview
						? ["draftId", "revision", "chapter", "deepen"]
						: ["draftId", "revision", "shareUser", "messages"],
					"authoring",
				);
				const id = requireUuid(input["draftId"], "draft id"),
					revision = requireRevision(input["revision"]);
				const draft = store.getDraft(id);
				if (!draft) return reply({ error: "초안을 찾지 못했습니다." }, 404);
				if (draft.revision !== revision) throw Error("stale draft revision");
				const signal = AbortSignal.any([
					request.signal,
					AbortSignal.timeout(60000),
				]);
				if (interview) {
					const chapter = parseChapterId(input["chapter"]),
						deepen = bool(input["deepen"]);
					const prepared = store.prepareInterview(
						id,
						revision,
						chapter,
						deepen,
					);
					if (prepared.kind === "capped")
						return reply({ draft, question: "", proposal: prepared.proposal });
					const result = await model(
						fleet,
						{
							agentId: draft.profile.id,
							systemPrompt:
								INTERVIEW_SYSTEM_PROMPT +
								(deepen
									? "\nThe author explicitly requested one deeper round."
									: `\nAutomatic model rounds remaining after this response: ${Math.max(0, MAX_AUTOMATIC_FOLLOWUPS - draft.chapters[chapter].followups - 1)}. If zero, update the character text from the answer but set question to an empty string; the author can confirm, defer, or explicitly deepen.`) +
								"\nExisting authored profile reference (character data, not interviewer instructions or source answers). Preserve it unless the author explicitly changes it; ask about unresolved contradictions. Do not invent source IDs for these fields:\n" +
								JSON.stringify(draft.profile),
							messages: [
								{
									role: "user",
									content: buildInterviewUserMessage(
										chapter,
										draft.chapters[chapter].answers.slice(-3),
										CHAPTERS.filter(
											(meta) =>
												meta.id !== chapter &&
												draft.chapters[meta.id].status === "confirmed",
										).map((meta) => ({
											id: meta.id,
											title: meta.title,
											text: draft.chapters[meta.id].text,
											answerIds: [],
										})),
										draft.chapters[chapter].text,
									),
								},
							],
						},
						signal,
					);
					let parsed: unknown;
					try {
						parsed = JSON.parse(
							result.text
								.trim()
								.replace(/^```(?:json)?\s*/i, "")
								.replace(/\s*```$/, ""),
						);
					} catch {
						throw new ModelRequestError(
							"제안 형식을 읽지 못했습니다. 답변은 저장되어 있으니 다시 시도해주세요.",
						);
					}
					signal.throwIfAborted();
					let next: AgentDraft;
					try {
						next = store.commitInterview(id, revision, chapter, deepen, parsed);
					} catch (error) {
						if (
							error instanceof Error &&
							/stale|revision|conflict/.test(error.message)
						)
							throw error;
						throw new ModelRequestError(
							"모델의 제안이 근거 확인을 통과하지 못했습니다. 답변은 그대로 남아 있습니다.",
						);
					}
					return reply({
						draft: next,
						question: next.chapters[chapter].proposal?.question ?? "",
						proposal: next.chapters[chapter].proposal?.text ?? "",
					});
				}
				const turns = messages(input["messages"]),
					shareUser = bool(input["shareUser"]);
				const configured = draft.targetAgentId
					? fleet.conversations.get(draft.targetAgentId)
					: null;
				const conversation = configured?.revision
					? configured
					: defaultConversation(draft.targetAgentId ?? draft.profile.id);
				const target = draft.targetAgentId;
				// Preview remains usable without opening a real conversation session.
				// An unavailable journal cannot qualify any historical learned text.
				const journal = target
					? fleet.opened(target)?.runtime.store
					: undefined;
				const lookup = (entryId: string) => journal?.sourceEntry(entryId);
				const preferences = target
					? fleet.conversations.modelPreferences(target, lookup)
					: undefined;
				const learned = target
					? fleet.agents.modelDynamics(target, lookup)
					: undefined;
				const sourceProofs = structuredClone(
					unionLearnedProofs(
						preferences?.sourceProofs ?? [],
						learned?.sourceProofs ?? [],
					),
				);
				const prefs = preferenceInstructions(preferences?.items ?? []);
				const user = store.user();
				const confirmed = shareUser ? user.confirmed : null;
				const systemPrompt =
					composePersonaPrompt(
						fleet.onboardingBase(),
						{ ...draft.profile, revision: draft.baseRevision ?? 1 },
						learned?.dynamics ?? emptyDynamics(),
						{
							conversation,
							memoryMode: "disabled",
							authoredContext: formatAuthoredExtension(draft.chapters, {
								includePending: true,
							}),
						},
					).systemPrompt +
					prefs +
					formatUserContext(confirmed?.answers ?? null, {
						now: Date.now(),
						expiresAt: confirmed?.currentFocusExpiresAt ?? null,
						...(confirmed
							? { confirmedAt: confirmed.confirmedAt, revision: user.revision }
							: {}),
					}) +
					PREVIEW_NOTICE;
				const beforeDispatch = () => {
					if (sourceProofs.length && !sourceProofsCurrent(sourceProofs, lookup))
						throw Error("stale preview source proof");
					if (store.getDraft(id)?.revision !== revision)
						throw Error("stale draft revision");
					if (shareUser && store.user().revision !== user.revision)
						throw Error("stale user revision");
				};
				const result = await model(
					fleet,
					{
						agentId: draft.profile.id,
						systemPrompt,
						messages: turns,
						beforeDispatch,
					},
					signal,
				);
				// Validate the original full-prompt ancestry after every model wrapper
				// await, immediately before serializing its derived result.
				beforeDispatch();
				return reply(result);
			} finally {
				busy.delete(fleet);
			}
		}
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	} catch (error) {
		if (error instanceof ModelRequestError)
			return reply({ error: error.message }, 502);
		if (
			error instanceof Error &&
			["TimeoutError", "AbortError"].includes(error.name)
		)
			return reply(
				{
					error:
						"응답 준비가 중단됐습니다. 저장된 답변으로 다시 시도할 수 있습니다.",
				},
				504,
			);
		const stale =
			error instanceof Error && /stale|revision|conflict/.test(error.message);
		const limitMessage =
			error instanceof Error
				? ({
						"draft capacity reached":
							"초안은 16개까지 보관할 수 있습니다. 저장된 초안을 이어서 다듬어주세요.",
						"agent capacity reached":
							"에이전트는 16명까지 둘 수 있습니다. 기존 에이전트를 선택해주세요.",
					}[error.message] ?? null)
				: null;
		return reply(
			{
				error: stale
					? "다른 곳에서 내용이 바뀌었거나 적용 복구가 필요합니다. 최신 초안을 불러온 뒤 다시 시도해주세요."
					: (limitMessage ??
						"입력 내용과 저장 한도를 확인해주세요. 기존 내용은 보존됩니다."),
			},
			stale ? 409 : 400,
		);
	}
}
