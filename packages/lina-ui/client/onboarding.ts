import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import {
	isOnboardingAbort,
	OnboardingHttpError,
	type OnboardingRequestFn,
	onboardingRequest,
} from "./onboarding-api.ts";
import {
	boundAnswerText,
	boundChapterText,
	boundUserAnswers,
	canAcceptAnswer,
	canApply,
	canCreateDraft,
	chapterProgress,
	chapterTitle,
	createDraftBody,
	draftRevisionConflict,
	followupsCapped,
	initialStage,
	interviewQuestion,
	needsInterviewRetry,
	parseOnboardingError,
	previewAllowed,
	remainingChapters,
	resumableTargetDraft,
	saveBadge,
	shouldClearPreview,
	untouchedChapters,
	userFieldSummaries,
	userPatch,
} from "./onboarding-model.ts";
import {
	type AgentDraft,
	CHAPTER_FINISH,
	CHAPTER_IDS,
	type ChapterId,
	type ExistingAgent,
	emptyUserAnswers,
	FAST_CHAPTER_IDS,
	type InterviewMode,
	type OnboardingSnapshot,
	PREVIEW_SCENES,
	PROFILE_LIMITS,
	type PreviewMessage,
	type PreviewSceneId,
	type PreviewSceneStatus,
	STATUS_LABEL,
	USER_FIELDS,
	type UserAnswers,
	type UserState,
	type WizardStage,
} from "./onboarding-types.ts";

export type Focusable = { focus(): void; isConnected: boolean };

export type WizardOpen = {
	opener?: Focusable;
	targetAgentId?: string | null;
	source?: "settings" | "add" | "editor";
};

type NodeLike = {
	textContent: string | null;
	hidden: boolean;
	disabled: boolean;
	value: string;
	open: boolean;
	checked?: boolean;
	id: string;
	className: string;
	type: string;
	isConnected: boolean;
	parent?: NodeLike | null;
	parentElement?: NodeLike | null;
	dataset?: Record<string, string>;
	focus(): void;
	click(): void;
	showModal(): void;
	close(): void;
	append(...nodes: NodeLike[]): void;
	replaceChildren(...nodes: NodeLike[]): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): NodeLike | null;
	querySelectorAll(selector: string): Iterable<NodeLike>;
	addEventListener(type: string, listener: (event: WizardEvent) => void): void;
};

export type WizardEvent = {
	preventDefault(): void;
	target?: unknown;
	currentTarget?: unknown;
};

export type WizardDocument = {
	createElement(tag: string): NodeLike;
	getElementById(id: string): NodeLike | null;
};

export type WizardDependencies = {
	request: OnboardingRequestFn;
	find: (id: string) => NodeLike;
	document: WizardDocument;
	now: () => number;
	uuid: () => string;
};

function defaults(): WizardDependencies {
	const doc = (globalThis as { document?: WizardDocument }).document;
	if (!doc) throw new Error("Onboarding requires a document");
	return {
		request: onboardingRequest,
		find: (id) => {
			const found = doc.getElementById(id);
			if (!found) throw new Error(`Missing interface element: ${id}`);
			return found;
		},
		document: doc,
		now: () => Date.now(),
		uuid: () => crypto.randomUUID(),
	};
}

function setText(node: { textContent: string | null }, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

function _isFocusable(value: unknown): value is Focusable {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Focusable).focus === "function"
	);
}

function attr(node: NodeLike | null, name: string): string {
	if (!node) return "";
	return node.getAttribute(name) ?? node.dataset?.[name] ?? "";
}

function closestAttr(start: unknown, name: string): NodeLike | null {
	let node: NodeLike | null | undefined = start as NodeLike | undefined;
	while (node && typeof node.getAttribute === "function") {
		if (node.getAttribute(name) || node.dataset?.[name]) return node;
		node = node.parent ?? node.parentElement ?? null;
	}
	return null;
}

export function createOnboardingWizard(
	options: {
		navigate: (id: string) => void;
		agents: () => ExistingAgent[];
		presets: () => AgentInput[];
	} & Partial<WizardDependencies>,
) {
	const deps: WizardDependencies =
		options.document && options.find
			? {
					request: options.request ?? onboardingRequest,
					find: options.find,
					document: options.document,
					now: options.now ?? (() => Date.now()),
					uuid: options.uuid ?? (() => crypto.randomUUID()),
				}
			: { ...defaults(), ...options };
	const { request, find, document: doc, uuid } = deps;
	const dialog = find("onboarding-dialog");
	const heading = find("onboarding-heading");
	const kicker = find("onboarding-kicker");
	const saveState = find("onboarding-save-state");
	const saveButton = find("onboarding-save");
	const progress = find("onboarding-progress");
	const body = find("onboarding-body");
	const status = find("onboarding-status");
	const back = find("onboarding-back");
	const primary = find("onboarding-primary");

	let generation = 0;
	let controller: AbortController | undefined;
	let inflight: Promise<unknown> | undefined;
	let opener: Focusable | undefined;
	let _source: WizardOpen["source"] = "add";
	let pendingTarget: string | null = null;
	let pendingPreset: string | undefined;
	let stage: WizardStage = "user";
	let user: UserState | null = null;
	let drafts: AgentDraft[] = [];
	let draft: AgentDraft | null = null;
	let localAnswers = emptyUserAnswers();
	let activeChapter: ChapterId = "identity";
	let answerDraft = "";
	let chapterDraft = "";
	let pendingAnswer: {
		chapter: ChapterId;
		text: string;
		answerId: string;
		saved: boolean;
	} | null = null;
	let deepening = false;
	let previewMessages: PreviewMessage[] = [];
	let previewResult: { text: string; provider: string; model: string } | null =
		null;
	let scenes: Record<PreviewSceneId, PreviewSceneStatus> = {
		ordinary: "pending",
		disagreement: "pending",
		reconnect: "pending",
	};
	let shareUser = false;
	let previewInput = "";
	let previewPending: string | null = null;
	let busy = false;
	let dirty = false;
	let error = "";
	let closing = false;

	const el = (tag: string, className?: string, text?: string): NodeLike => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};

	const field = (id: string, value: string): string => {
		const node = doc.getElementById(id) ?? body.querySelector(`#${id}`);
		return node && "value" in node ? node.value : value;
	};

	const readUserForm = (): UserAnswers => {
		const next = emptyUserAnswers();
		for (const item of USER_FIELDS)
			next[item.key] = field(
				`onboarding-user-${item.key}`,
				localAnswers[item.key],
			);
		return next;
	};

	const badge = (): string =>
		saveBadge({
			busy,
			error,
			user,
			draft,
			dirty,
			...(busy && (stage === "interview" || stage === "preview")
				? { modelBusy: true }
				: {}),
		});

	const setBusy = (value: boolean): void => {
		busy = value;
		dialog.setAttribute("aria-busy", String(value));
		saveButton.disabled = value;
		primary.disabled = value;
		back.disabled = value && stage !== "interview";
		setText(saveState, badge());
	};

	const paintChrome = (): void => {
		const titles: Record<WizardStage, string> = {
			user: "나를 알려주세요",
			"user-review": "소개 확인",
			path: "에이전트 선택",
			mode: "만드는 속도",
			interview: "캐릭터 인터뷰",
			profile: "기본 프로필",
			preview: "미리보기",
			apply: "적용",
		};
		setText(kicker, "나의 소개와 에이전트");
		setText(heading, titles[stage]);
		dialog.setAttribute("data-onboarding-stage", stage);
		setText(saveState, badge());
		setText(status, error);
		const _canBack = stage !== "user" && !(stage === "path" && !draft);
		back.hidden = stage === "user";
		if (stage === "path") back.hidden = !user?.confirmed;
		back.hidden = stage === "user";
		const labels: Record<WizardStage, string> = {
			user: "작성한 소개 검토",
			"user-review": "소개 확인",
			path: "소개만 저장하고 나가기",
			mode: "이 속도로 시작",
			interview: "프로필로",
			profile: "미리보기",
			preview: "적용 검토",
			apply: "이 에이전트 적용",
		};
		setText(primary, labels[stage]);
		primary.hidden = stage === "mode";
		if (stage === "interview" && draft) {
			progress.hidden = false;
			setText(progress, chapterProgress(draft).summary);
		} else progress.hidden = true;
	};

	const addAction = (
		node: NodeLike,
		action: string,
		extra?: Record<string, string>,
	): NodeLike => {
		node.setAttribute("data-onboarding-action", action);
		if (extra)
			for (const [key, value] of Object.entries(extra))
				node.setAttribute(key, value);
		return node;
	};

	const renderUser = (): void => {
		body.append(
			el(
				"p",
				"onboarding-lead",
				"에이전트가 당신을 어떻게 부르면 좋을지, 알아두면 좋은 것만 적어 주세요. 비워 두어도 됩니다.",
			),
		);
		for (const item of USER_FIELDS) {
			const label = el("label", "onboarding-field");
			label.append(el("span", undefined, item.label));
			const input = el(item.key === "address" ? "input" : "textarea");
			input.id = `onboarding-user-${item.key}`;
			input.setAttribute("maxlength", "600");
			if (item.key !== "address") input.setAttribute("rows", "2");
			input.value = localAnswers[item.key];
			label.append(input);
			label.append(el("small", "agent-hint", item.hint));
			body.append(label);
		}
	};

	const renderReview = (): void => {
		body.append(
			el(
				"p",
				"onboarding-lead",
				"적은 답을 그대로 확인합니다. 소개를 확인해도 에이전트를 바로 만들지는 않습니다.",
			),
		);
		const list = el("ul", "onboarding-review");
		for (const row of userFieldSummaries(localAnswers)) {
			const item = el("li");
			item.setAttribute("data-user-field", row.key);
			item.append(
				el("strong", undefined, row.label),
				el(
					"span",
					row.blank ? "onboarding-blank" : undefined,
					row.blank ? "비워 둠" : row.value,
				),
			);
			list.append(item);
		}
		body.append(list);
		body.append(
			addAction(el("button", "text-button", "소개 수정"), "edit-user"),
		);
	};

	const renderPath = (): void => {
		body.append(
			el(
				"p",
				"onboarding-lead",
				"소개는 이미 따로 저장됩니다. 있는 에이전트와 대화하거나, 새 캐릭터 초안만 만들 수 있습니다.",
			),
		);
		if (user?.confirmed) {
			const summary = el("p", "onboarding-confirmed");
			summary.id = "onboarding-user-confirmed";
			setText(summary, "소개가 확인되어 있습니다. 다시 묻지 않습니다.");
			body.append(summary);
			body.append(
				addAction(el("button", "text-button", "소개 다시 보기"), "edit-user"),
			);
		}
		const existing = el("section", "onboarding-section");
		existing.append(el("h3", undefined, "있는 에이전트"));
		existing.append(
			el(
				"p",
				"agent-hint",
				"선택하면 그 에이전트의 대화로 이동합니다. 방을 새로 만들지는 않습니다.",
			),
		);
		for (const agent of options.agents()) {
			const row = el("div", "onboarding-agent-row");
			const button = el("button", "secondary-button", agent.name);
			button.setAttribute("data-onboarding-action", "choose-existing");
			button.setAttribute("data-agent-id", agent.id);
			row.append(button);
			const share = el("label", "onboarding-share");
			const box = el("input");
			box.type = "checkbox";
			box.setAttribute("data-onboarding-action", "share-agent");
			box.setAttribute("data-agent-id", agent.id);
			if (box.checked !== undefined)
				box.checked = Boolean(user?.sharedAgentIds.includes(agent.id));
			share.append(box, el("span", undefined, "소개 공유"));
			row.append(share);
			existing.append(row);
		}
		body.append(existing);
		if (drafts.length) {
			const resume = el("section", "onboarding-section");
			resume.append(el("h3", undefined, "저장된 초안"));
			for (const item of drafts) {
				const button = el(
					"button",
					"secondary-button",
					`${item.profile.name} · ${item.mode}`,
				);
				button.setAttribute("data-onboarding-action", "resume-draft");
				button.setAttribute("data-draft-id", item.id);
				resume.append(button);
			}
			body.append(resume);
		}
		const create = el("section", "onboarding-section");
		create.append(el("h3", undefined, "새 캐릭터 초안"));
		create.append(
			el(
				"p",
				"agent-hint",
				"프리셋은 바로 에이전트가 되지 않고 초안만 만듭니다.",
			),
		);
		for (const preset of options.presets()) {
			const button = el("button", "secondary-button", preset.name);
			button.setAttribute("data-onboarding-action", "choose-preset");
			button.setAttribute("data-preset-id", preset.id);
			create.append(button);
		}
		create.append(
			addAction(
				el("button", "secondary-button", "직접 만들기"),
				"choose-custom",
			),
		);
		body.append(create);
	};

	const renderMode = (): void => {
		body.append(
			el(
				"p",
				"onboarding-lead",
				"빠른 시작은 씨앗 질문 세 개로 초안을 만들고, 자세한 인터뷰는 여섯 장을 하나씩 다듬습니다. 나중에 바꿔도 적은 답은 남습니다.",
			),
		);
		const fast = el("button", "onboarding-choice", "빠르게");
		fast.setAttribute("data-onboarding-action", "choose-mode");
		fast.setAttribute("data-mode", "fast");
		fast.append(
			el("small", undefined, "정체, 태도, 관계 세 질문으로 초안을 만듭니다."),
		);
		const thoughtful = el("button", "onboarding-choice", "자세히");
		thoughtful.setAttribute("data-onboarding-action", "choose-mode");
		thoughtful.setAttribute("data-mode", "thoughtful");
		thoughtful.append(
			el("small", undefined, "여섯 장을 대화로 확인하고 미루거나 다듬습니다."),
		);
		body.append(fast, thoughtful);
	};

	const renderInterview = (): void => {
		if (!draft) return;
		if (draft.staleExtension) {
			const notice = el(
				"p",
				"onboarding-stale",
				"이 에이전트의 설정이 다른 편집으로 바뀌었습니다. 장 내용은 제안 상태로 다시 확인한 뒤에 적용하세요.",
			);
			notice.id = "onboarding-stale";
			body.append(notice);
		}
		const nav = el("nav", "onboarding-chapters");
		nav.setAttribute("aria-label", "캐릭터 장");
		const ids = draft.mode === "fast" ? FAST_CHAPTER_IDS : CHAPTER_IDS;
		for (const id of ids) {
			const chapter = draft.chapters[id];
			const button = el("button", "onboarding-chapter", chapterTitle(id));
			button.setAttribute("data-onboarding-action", "select-chapter");
			button.setAttribute("data-chapter-id", id);
			button.setAttribute("data-chapter-status", chapter.status);
			if (id === activeChapter) button.setAttribute("aria-current", "true");
			button.append(el("small", undefined, STATUS_LABEL[chapter.status]));
			nav.append(button);
		}
		body.append(nav);
		const chapter = draft.chapters[activeChapter];
		body.append(el("h3", undefined, chapterTitle(activeChapter)));
		body.append(el("p", "agent-hint", CHAPTER_FINISH[activeChapter]));
		body.append(
			el("p", "onboarding-progress-copy", chapterProgress(draft).summary),
		);
		if (chapter.answers.length) {
			const list = el("ol", "onboarding-answers");
			for (const answer of chapter.answers) {
				const item = el("li");
				item.append(el("span", "onboarding-kicker", "원문"));
				item.append(el("p", undefined, answer.text));
				list.append(item);
			}
			body.append(list);
		}
		if (chapter.proposal) {
			const box = el("blockquote", "onboarding-proposal");
			box.append(el("strong", undefined, "제안 · 원문과 별개"));
			box.append(el("p", undefined, chapter.proposal.text));
			body.append(box);
		}
		const question = interviewQuestion(
			chapter,
			activeChapter,
			draft.mode,
			deepening,
		);
		if (question) body.append(el("p", "onboarding-question", question));
		else
			body.append(
				el(
					"p",
					"onboarding-question",
					"자동 질문은 여기까지입니다. 이 장을 확인하거나 미뤄주세요.",
				),
			);
		const authored = el("label", "onboarding-field");
		authored.append(el("span", undefined, "장 초안"));
		const chapterField = el("textarea");
		chapterField.id = "onboarding-chapter-text";
		chapterField.setAttribute("maxlength", "2000");
		chapterField.value =
			chapterDraft || chapter.text || chapter.proposal?.text || "";
		authored.append(chapterField);
		body.append(authored);
		if (
			question ||
			deepening ||
			pendingAnswer ||
			needsInterviewRetry(chapter)
		) {
			const reply = el("label", "onboarding-field");
			reply.append(el("span", undefined, "답"));
			const input = el("textarea");
			input.id = "onboarding-answer";
			input.setAttribute("maxlength", "4000");
			input.value =
				answerDraft ||
				pendingAnswer?.text ||
				(needsInterviewRetry(chapter)
					? (chapter.answers.at(-1)?.text ?? "")
					: "");
			reply.append(input);
			body.append(reply);
			if (
				canAcceptAnswer(chapter) ||
				pendingAnswer?.saved ||
				needsInterviewRetry(chapter)
			)
				body.append(
					addAction(
						el(
							"button",
							"secondary-button",
							pendingAnswer?.saved ? "다시 질문하기" : "답 보내기",
						),
						"send-answer",
					),
				);
		}
		if (followupsCapped(chapter))
			body.append(
				addAction(el("button", "text-button", "더 깊게 물어보기"), "deepen"),
			);
		body.append(
			addAction(
				el("button", "secondary-button", "이 장 확인"),
				"confirm-chapter",
			),
			addAction(el("button", "text-button", "이 장 미루기"), "defer-chapter"),
		);
	};

	const renderProfile = (): void => {
		if (!draft) return;
		body.append(
			el(
				"p",
				"onboarding-lead",
				"비어 있는 필수 값은 '아직 정하지 않았습니다.'로 둡니다. 가져온 원문은 바꾸지 않는 한 그대로 둡니다.",
			),
		);
		const fields: [keyof AgentInput, string, number][] = [
			["name", "이름", PROFILE_LIMITS.name],
			["role", "하는 일", PROFILE_LIMITS.role],
			["personality", "기본 인격", PROFILE_LIMITS.personality],
			["voice", "말투", PROFILE_LIMITS.voice],
			["profile", "프로필", PROFILE_LIMITS.profile],
			["appearance", "외형", PROFILE_LIMITS.appearance],
		];
		for (const [key, label, max] of fields) {
			const wrap = el("label", "onboarding-field");
			wrap.append(el("span", undefined, `${label} · ${String(max)}자`));
			const input = el(key === "name" || key === "role" ? "input" : "textarea");
			input.id = `onboarding-profile-${key}`;
			input.setAttribute("maxlength", String(max));
			input.value = String(draft.profile[key] ?? "");
			wrap.append(input);
			body.append(wrap);
		}
	};

	const renderPreview = (): void => {
		body.append(
			el(
				"p",
				"onboarding-disclaimer",
				"이 미리보기에는 도구, 기억, 실제 대화 기록이 없습니다. 적용한 뒤의 대화와 다를 수 있습니다.",
			),
		);
		const share = el("label", "onboarding-share");
		const box = el("input");
		box.type = "checkbox";
		box.id = "onboarding-share-user";
		if (box.checked !== undefined) box.checked = shareUser;
		share.append(
			box,
			el("span", undefined, "확인한 소개를 이 미리보기에 넣기"),
		);
		body.append(share);
		const scenesWrap = el("div", "onboarding-scenes");
		for (const scene of PREVIEW_SCENES) {
			const row = el("div", "onboarding-scene");
			const button = el("button", "secondary-button", scene.label);
			button.setAttribute("data-onboarding-action", "preview-scene");
			button.setAttribute("data-scene", scene.id);
			row.append(button);
			row.append(
				el(
					"small",
					undefined,
					scenes[scene.id] === "pending"
						? "아직"
						: scenes[scene.id] === "reviewed"
							? "봄"
							: "건너뜀",
				),
			);
			row.append(
				addAction(el("button", "text-button", "건너뛰기"), "skip-scene", {
					"data-scene": scene.id,
				}),
			);
			scenesWrap.append(row);
		}
		body.append(scenesWrap);
		const log = el("div", "onboarding-transcript");
		log.id = "onboarding-transcript";
		for (const message of previewMessages) {
			const suffix =
				message.role === "assistant" &&
				previewResult &&
				message.content === previewResult.text
					? ` · ${previewResult.provider}`
					: "";
			const item = el(
				"p",
				`onboarding-${message.role}`,
				message.content + suffix,
			);
			log.append(item);
		}
		body.append(log);
		const reply = el("label", "onboarding-field");
		reply.append(el("span", undefined, "자유 대화"));
		const input = el("textarea");
		input.id = "onboarding-preview-input";
		input.value = previewInput;
		reply.append(input);
		body.append(reply);
		body.append(
			addAction(
				el("button", "secondary-button", "미리보기 보내기"),
				"send-preview",
			),
		);
	};

	const renderApply = (): void => {
		if (!draft || !user) return;
		if (draft.staleExtension) {
			const notice = el(
				"p",
				"onboarding-stale",
				"이 에이전트의 설정이 다른 편집으로 바뀌었습니다. 장 내용을 다시 확인한 뒤에 적용하세요.",
			);
			notice.id = "onboarding-stale";
			body.append(notice);
		}
		body.append(
			el(
				"p",
				"onboarding-lead",
				"적용하면 이 초안으로 에이전트를 저장하고 대화로 이동합니다.",
			),
		);
		const ready = canApply(draft);
		if (!ready.ok)
			body.append(
				el("p", "settings-status", ready.reason ?? ""),
				addAction(
					el("button", "text-button", "남은 장 미루고 적용 준비"),
					"defer-remaining",
				),
			);
		const share = el("label", "onboarding-share");
		const box = el("input");
		box.type = "checkbox";
		box.id = "onboarding-apply-share";
		if (box.checked !== undefined) box.checked = shareUser;
		share.append(
			box,
			el("span", undefined, "확인한 소개를 이 에이전트와 공유"),
		);
		body.append(share);
		body.append(
			el(
				"p",
				"agent-hint",
				"미리보기 장면: 일상 " +
					scenes.ordinary +
					", 의견 " +
					scenes.disagreement +
					", 재회 " +
					scenes.reconnect,
			),
		);
	};

	const render = (): void => {
		body.replaceChildren();
		paintChrome();
		if (stage === "user") renderUser();
		else if (stage === "user-review") renderReview();
		else if (stage === "path") renderPath();
		else if (stage === "mode") renderMode();
		else if (stage === "interview") renderInterview();
		else if (stage === "profile") renderProfile();
		else if (stage === "preview") renderPreview();
		else renderApply();
	};

	const fail = (caught: unknown): void => {
		if (isOnboardingAbort(caught) || closing) return;
		if (caught instanceof OnboardingHttpError) {
			error = caught.message;
			const parsed = parseOnboardingError(caught.status, caught.body);
			if (parsed.reload) void load();
			else render();
			return;
		}
		error =
			caught instanceof Error && caught.message
				? caught.message
				: "요청을 완료하지 못했습니다.";
		render();
	};

	const run = async (action: () => Promise<void>): Promise<void> => {
		const mine = generation;
		if (busy) return;
		setBusy(true);
		error = "";
		const signal = controller?.signal;
		try {
			const task = action();
			inflight = task;
			await task;
			if (mine === generation && !signal?.aborted) {
				dirty = false;
				render();
			}
		} catch (caught) {
			if (mine === generation) fail(caught);
		} finally {
			if (mine === generation) {
				setBusy(false);
				inflight = undefined;
			}
		}
	};

	const load = async (): Promise<void> => {
		const snapshot = (await request(
			"/api/onboarding",
			"GET",
			undefined,
			controller?.signal,
		)) as OnboardingSnapshot;
		user = snapshot.user;
		drafts = snapshot.drafts;
		localAnswers = snapshot.user.draft;
		if (draft) {
			const latest = drafts.find((item) => item.id === draft?.id);
			if (latest) {
				if (shouldClearPreview(draft, latest)) {
					previewMessages = [];
					previewResult = null;
				}
				draft = latest;
			}
		}
		if (!draft && pendingTarget) {
			const currentRevision =
				options.agents().find((item) => item.id === pendingTarget)?.revision ??
				null;
			const found = resumableTargetDraft(
				drafts,
				pendingTarget,
				currentRevision,
			);
			if (found) draft = found;
		}
		if (!stageLocked()) {
			if (draft) stage = "interview";
			else if (pendingTarget && snapshot.user.confirmed) stage = "mode";
			else
				stage = initialStage(snapshot.user, { forceUser: sourceForceUser() });
		}
		if (draft && remainingChapters(draft)[0])
			activeChapter = remainingChapters(draft)[0] ?? "identity";
		syncShareUser();
	};

	const sourceForceUser = (): boolean => false;

	const resetInterviewBuffers = (): void => {
		chapterDraft = "";
		answerDraft = "";
		pendingAnswer = null;
		deepening = false;
		activeChapter = "identity";
		previewPending = null;
	};

	const syncShareUser = (): void => {
		shareUser = Boolean(
			draft?.targetAgentId &&
				user?.sharedAgentIds.includes(draft.targetAgentId),
		);
	};

	const stageLocked = (): boolean =>
		stage === "mode" || stage === "preview" || stage === "apply";

	const patchUser = async (confirm: boolean): Promise<void> => {
		if (!user) return;
		localAnswers = stage === "user" ? readUserForm() : localAnswers;
		const bounded = boundUserAnswers(localAnswers);
		if (!bounded.ok) {
			error = bounded.error ?? "";
			render();
			return;
		}
		user = (await request(
			"/api/onboarding/user",
			"PATCH",
			userPatch({
				revision: user.revision,
				answers: bounded.answers,
				sharedAgentIds: user.sharedAgentIds,
				confirm,
			}),
			controller?.signal,
		)) as UserState;
		localAnswers = user.draft;
	};

	const createDraft = async (mode: InterviewMode): Promise<void> => {
		if (!canCreateDraft(options.agents().length, pendingTarget)) {
			error = "에이전트는 16명까지 둘 수 있습니다.";
			stage = "path";
			render();
			return;
		}
		const body = createDraftBody({
			targetAgentId: pendingTarget,
			mode,
			...(pendingPreset ? { presetId: pendingPreset } : {}),
		});
		draft = (await request(
			"/api/onboarding/drafts",
			"POST",
			body,
			controller?.signal,
		)) as AgentDraft;
		drafts = drafts.some((item) => item.id === draft?.id)
			? drafts.map((item) => (item.id === draft?.id ? draft : item))
			: [...drafts, draft];
		stage = "interview";
		activeChapter = draft.mode === "fast" ? "identity" : "identity";
		syncShareUser();
	};

	const patchDraft = async (patch: Record<string, unknown>): Promise<void> => {
		if (!draft) return;
		const next = (await request(
			`/api/onboarding/drafts/${draft.id}`,
			"PATCH",
			{ revision: draft.revision, ...patch },
			controller?.signal,
		)) as AgentDraft;
		if (shouldClearPreview(draft, next)) {
			previewMessages = [];
			previewResult = null;
		}
		draft = next;
	};

	const persistChapterEdits = async (): Promise<boolean> => {
		if (!draft || stage !== "interview") return true;
		chapterDraft = field("onboarding-chapter-text", chapterDraft);
		const bounded = boundChapterText(chapterDraft);
		if (!bounded.ok) {
			error = bounded.error ?? "";
			return false;
		}
		const previous = draft.chapters[activeChapter];
		if (!bounded.text.trim() && previous.status === "untouched") {
			chapterDraft = bounded.text;
			return true;
		}
		if (bounded.text === previous.text && previous.status !== "untouched") {
			chapterDraft = bounded.text;
			return true;
		}
		const status =
			previous.status === "deferred"
				? "deferred"
				: bounded.text === previous.text && previous.status === "confirmed"
					? "confirmed"
					: "proposed";
		await patchDraft({
			chapter: {
				id: activeChapter,
				text: bounded.text,
				status,
			},
		});
		chapterDraft = bounded.text;
		return true;
	};

	const persistPendingAnswer = async (): Promise<boolean> => {
		if (!draft || stage !== "interview") return true;
		const text = field(
			"onboarding-answer",
			answerDraft || pendingAnswer?.text || "",
		);
		if (!text.trim()) return true;
		const bounded = boundAnswerText(text);
		if (!bounded.ok) {
			error = bounded.error ?? "";
			answerDraft = text;
			return false;
		}
		answerDraft = bounded.text;
		const previous = draft.chapters[activeChapter];
		const already = previous.answers.some((item) => item.text === bounded.text);
		const same =
			pendingAnswer &&
			pendingAnswer.chapter === activeChapter &&
			pendingAnswer.text === bounded.text;
		if (!same)
			pendingAnswer = {
				chapter: activeChapter,
				text: bounded.text,
				answerId: uuid(),
				saved: already,
			};
		const pending = pendingAnswer;
		if (!pending || pending.saved) return true;
		if (!canAcceptAnswer(previous)) return true;
		draft = (await request(
			`/api/onboarding/drafts/${draft.id}/answer`,
			"POST",
			{
				revision: draft.revision,
				chapter: activeChapter,
				text: pending.text,
				answerId: pending.answerId,
			},
			controller?.signal,
		)) as AgentDraft;
		pending.saved = true;
		return true;
	};

	const persistInterviewDrafts = async (): Promise<boolean> => {
		if (!(await persistChapterEdits())) return false;
		return persistPendingAnswer();
	};

	const postPreview = async (content: string): Promise<void> => {
		if (!draft) return;
		const text = content.trim();
		if (!text) {
			error = "미리볼 말을 먼저 적어 주세요.";
			return;
		}
		const box = doc.getElementById("onboarding-share-user");
		if (box?.checked !== undefined) shareUser = box.checked;
		previewPending = previewPending === text ? previewPending : text;
		previewInput = previewPending;
		const messages = [
			...previewMessages,
			{ role: "user" as const, content: previewPending },
		];
		const allowed = previewAllowed(messages);
		if (!allowed.ok) {
			error = allowed.reason ?? "";
			return;
		}
		previewResult = (await request(
			"/api/onboarding/preview",
			"POST",
			{
				draftId: draft.id,
				revision: draft.revision,
				shareUser,
				messages,
			},
			controller?.signal,
		)) as { text: string; provider: string; model: string };
		previewMessages = [
			...messages,
			{ role: "assistant", content: previewResult.text },
		];
		previewPending = null;
		previewInput = "";
	};

	const collectProfile = (): AgentInput | null => {
		if (!draft) return null;
		const value = { ...draft.profile };
		const keys = [
			"name",
			"role",
			"personality",
			"voice",
			"profile",
			"appearance",
		] as const;
		for (const key of keys) {
			const node = doc.getElementById(`onboarding-profile-${key}`);
			if (node) value[key] = node.value;
		}
		return value;
	};

	const go = (next: WizardStage): void => {
		if (stage === "user") localAnswers = readUserForm();
		if (stage === "interview") {
			answerDraft = field("onboarding-answer", answerDraft);
			chapterDraft = field("onboarding-chapter-text", chapterDraft);
		}
		stage = next;
		render();
	};

	const primaryAction = (): void => {
		if (stage === "user") {
			localAnswers = readUserForm();
			go("user-review");
			return;
		}
		if (stage === "user-review") {
			void run(async () => {
				await patchUser(true);
				stage = pendingTarget ? "mode" : "path";
			});
			return;
		}
		if (stage === "path") {
			void run(async () => {
				await patchUser(false);
				await dismiss(false);
			});
			return;
		}
		if (stage === "interview") {
			void run(async () => {
				if (!(await persistInterviewDrafts())) return;
				stage = "profile";
			});
			return;
		}
		if (stage === "profile") {
			void run(async () => {
				const profile = collectProfile();
				if (profile) await patchDraft({ profile });
				stage = "preview";
			});
			return;
		}
		if (stage === "preview") {
			go("apply");
			return;
		}
		if (stage === "apply") {
			void run(async () => {
				if (!draft || !user) return;
				const ready = canApply(draft);
				if (!ready.ok) {
					error = ready.reason ?? "";
					return;
				}
				const box = doc.getElementById("onboarding-apply-share");
				if (box?.checked !== undefined) shareUser = box.checked;
				const applied = (await request(
					`/api/onboarding/drafts/${draft.id}/apply`,
					"POST",
					{
						revision: draft.revision,
						shareUser,
						userRevision: user.revision,
					},
					controller?.signal,
				)) as { agentId: string };
				await dismiss(false);
				options.navigate(applied.agentId);
			});
		}
	};

	const backAction = (): void => {
		if (stage === "user-review") go("user");
		else if (stage === "path") go("user-review");
		else if (stage === "mode") go("path");
		else if (stage === "interview")
			void run(async () => {
				if (!(await persistInterviewDrafts())) return;
				stage = draft ? "mode" : "path";
			});
		else if (stage === "profile") go("interview");
		else if (stage === "preview") go("profile");
		else if (stage === "apply") go("preview");
	};

	const handleAction = (action: string, node: NodeLike): void => {
		if (action === "edit-user") {
			go("user");
			return;
		}
		if (action === "choose-existing") {
			const id = attr(node, "data-agent-id");
			if (!id) return;
			void dismiss().then(() => options.navigate(id));
			return;
		}
		if (action === "choose-preset") {
			pendingPreset = attr(node, "data-preset-id");
			pendingTarget = null;
			go("mode");
			return;
		}
		if (action === "choose-custom") {
			pendingPreset = undefined;
			pendingTarget = null;
			go("mode");
			return;
		}
		if (action === "resume-draft") {
			const id = attr(node, "data-draft-id");
			const found = drafts.find((item) => item.id === id);
			if (!found) return;
			const currentRevision = found.targetAgentId
				? (options.agents().find((item) => item.id === found.targetAgentId)
						?.revision ?? null)
				: null;
			if (draftRevisionConflict(found, currentRevision)) {
				error =
					"이 초안은 에이전트가 바뀐 뒤의 것이 아닙니다. 덮어쓰지 않았습니다.";
				if (draft && !draftRevisionConflict(draft, currentRevision)) {
					render();
					return;
				}
			}
			if (draft?.id !== found.id) resetInterviewBuffers();
			draft = found;
			syncShareUser();
			go("interview");
			return;
		}
		if (action === "choose-mode") {
			const mode = attr(node, "data-mode") as InterviewMode;
			void run(async () => {
				if (draft) {
					if (draft.mode !== mode) await patchDraft({ mode });
					stage = "interview";
					return;
				}
				await createDraft(mode);
			});
			return;
		}
		if (action === "select-chapter") {
			const id = attr(node, "data-chapter-id") as ChapterId;
			if ((CHAPTER_IDS as readonly string[]).includes(id)) {
				void run(async () => {
					if (id === activeChapter) return;
					if (!(await persistInterviewDrafts())) return;
					answerDraft = "";
					chapterDraft = "";
					pendingAnswer = null;
					deepening = false;
					activeChapter = id;
				});
			}
			return;
		}
		if (action === "send-answer") {
			void run(async () => {
				if (!draft) return;
				if (followupsCapped(draft.chapters[activeChapter]) && !deepening) {
					error = "자동 질문은 여기까지입니다. 이 장을 확인하거나 미뤄주세요.";
					return;
				}
				const previous = draft.chapters[activeChapter];
				const last = previous.answers.at(-1);
				const text = field(
					"onboarding-answer",
					answerDraft || pendingAnswer?.text || last?.text || "",
				);
				const bounded = boundAnswerText(text);
				if (!bounded.ok) {
					error = bounded.error ?? "";
					answerDraft = text;
					return;
				}
				answerDraft = bounded.text;
				const same =
					pendingAnswer &&
					pendingAnswer.chapter === activeChapter &&
					pendingAnswer.text === bounded.text;
				if (!same)
					pendingAnswer = {
						chapter: activeChapter,
						text: bounded.text,
						answerId: last && last.text === bounded.text ? last.id : uuid(),
						saved: Boolean(last && last.text === bounded.text),
					};
				const pending = pendingAnswer;
				if (!pending) return;
				if (!pending.saved) {
					draft = (await request(
						`/api/onboarding/drafts/${draft.id}/answer`,
						"POST",
						{
							revision: draft.revision,
							chapter: activeChapter,
							text: pending.text,
							answerId: pending.answerId,
						},
						controller?.signal,
					)) as AgentDraft;
					pending.saved = true;
				}
				const interviewed = (await request(
					"/api/onboarding/interview",
					"POST",
					{
						draftId: draft.id,
						revision: draft.revision,
						chapter: activeChapter,
						deepen: deepening,
					},
					controller?.signal,
				)) as { draft: AgentDraft; question: string; proposal: string };
				draft = interviewed.draft;
				pendingAnswer = null;
				deepening = false;
				answerDraft = "";
			});
			return;
		}
		if (action === "deepen") {
			void run(async () => {
				if (!draft) return;
				deepening = true;
				const interviewed = (await request(
					"/api/onboarding/interview",
					"POST",
					{
						draftId: draft.id,
						revision: draft.revision,
						chapter: activeChapter,
						deepen: true,
					},
					controller?.signal,
				)) as { draft: AgentDraft };
				draft = interviewed.draft;
			});
			return;
		}
		if (action === "confirm-chapter" || action === "defer-chapter") {
			void run(async () => {
				if (!draft) return;
				const text = field(
					"onboarding-chapter-text",
					chapterDraft || draft.chapters[activeChapter].text,
				);
				const bounded = boundChapterText(text);
				if (!bounded.ok) {
					error = bounded.error ?? "";
					return;
				}
				await patchDraft({
					chapter: {
						id: activeChapter,
						text: bounded.text,
						status: action === "confirm-chapter" ? "confirmed" : "deferred",
					},
				});
				chapterDraft = "";
				const next = draft ? remainingChapters(draft)[0] : undefined;
				if (next) activeChapter = next;
			});
			return;
		}
		if (action === "defer-remaining") {
			void run(async () => {
				if (!draft) return;
				for (const id of untouchedChapters(draft).concat(
					CHAPTER_IDS.filter(
						(item) => draft?.chapters[item].status === "proposed",
					),
				)) {
					await patchDraft({
						chapter: { id, text: draft.chapters[id].text, status: "deferred" },
					});
				}
			});
			return;
		}
		if (action === "preview-scene" || action === "skip-scene") {
			const id = attr(node, "data-scene") as PreviewSceneId;
			if (action === "skip-scene") {
				scenes[id] = "skipped";
				render();
				return;
			}
			const scene = PREVIEW_SCENES.find((item) => item.id === id);
			const current = draft;
			if (!scene || !current) return;
			void run(async () => {
				await postPreview(scene.prompt);
				if (!previewPending) scenes[id] = "reviewed";
			});
			return;
		}
		if (action === "send-preview") {
			void run(async () => {
				const text = field(
					"onboarding-preview-input",
					previewInput || previewPending || "",
				);
				await postPreview(text);
			});
			return;
		}
		if (action === "share-agent") {
			const id = attr(node, "data-agent-id");
			if (!user || !id) return;
			const selected = new Set(user.sharedAgentIds);
			if (node.checked) selected.add(id);
			else selected.delete(id);
			void run(async () => {
				user = (await request(
					"/api/onboarding/user",
					"PATCH",
					userPatch({
						revision: user?.revision ?? 0,
						answers: localAnswers,
						sharedAgentIds: [...selected],
						confirm: false,
					}),
					controller?.signal,
				)) as UserState;
			});
		}
	};

	body.addEventListener("click", (event) => {
		const node = closestAttr(event.target, "data-onboarding-action");
		if (!node || busy) return;
		handleAction(attr(node, "data-onboarding-action"), node);
	});
	body.addEventListener("input", () => {
		dirty = true;
		setText(saveState, badge());
	});
	saveButton.addEventListener("click", () => {
		void run(async () => {
			if (stage === "user" || stage === "user-review" || stage === "path")
				await patchUser(false);
			else if (stage === "profile") {
				const profile = collectProfile();
				if (profile) await patchDraft({ profile });
			} else if (stage === "interview" && draft) {
				await persistInterviewDrafts();
			}
		});
	});
	primary.addEventListener("click", primaryAction);
	back.addEventListener("click", backAction);
	const closeWizard = (): void => {
		if (stage === "interview" && !busy) {
			void run(async () => {
				if (!(await persistInterviewDrafts())) return;
				await dismiss(false);
			});
			return;
		}
		void dismiss();
	};
	for (const close of dialog.querySelectorAll("[data-close]"))
		close.addEventListener("click", (event) => {
			event.preventDefault();
			closeWizard();
		});
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		closeWizard();
	});
	dialog.addEventListener("close", () => {
		generation += 1;
		controller?.abort(new Error("aborted:closed"));
		if (opener?.isConnected) opener.focus();
	});

	async function dismiss(wait = true): Promise<void> {
		closing = true;
		controller?.abort(new Error("aborted:closed"));
		if (wait && inflight) await inflight.catch(() => undefined);
		if (dialog.open) dialog.close();
		closing = false;
		inflight = undefined;
	}

	async function open(opts: WizardOpen = {}): Promise<void> {
		generation += 1;
		controller?.abort(new Error("aborted:generation"));
		controller = new AbortController();
		opener = opts.opener;
		_source = opts.source ?? "add";
		pendingTarget = opts.targetAgentId ?? null;
		pendingPreset = undefined;
		draft = null;
		stage = "user";
		error = "";
		dirty = false;
		shareUser = false;
		previewMessages = [];
		previewResult = null;
		resetInterviewBuffers();
		scenes = {
			ordinary: "pending",
			disagreement: "pending",
			reconnect: "pending",
		};
		closing = false;
		if (!dialog.open) dialog.showModal();
		setBusy(true);
		try {
			await load();
			render();
		} catch (caught) {
			fail(caught);
		} finally {
			setBusy(false);
		}
	}

	return { open, dismiss };
}
