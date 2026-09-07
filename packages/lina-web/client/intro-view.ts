import {
	answeredTurnCount,
	displayName,
	shareCheckbox,
	turnTarget,
} from "./intro-model.ts";
import {
	CHAPTER_REVIEW_FIELDS,
	type InterviewMode,
	type IntroBubble,
	type IntroEntry,
	type IntroRoom,
	type IntroSnapshot,
	type LegacyDraftRef,
	PROFILE_REVIEW_FIELDS,
	USER_REVIEW_FIELDS,
} from "./intro-types.ts";
import { renderMarkdown } from "./markdown.ts";
import { UNSPECIFIED } from "./onboarding-types.ts";

export type IntroNode = {
	textContent: string | null;
	hidden: boolean;
	disabled: boolean;
	value: string;
	checked?: boolean;
	id: string;
	className: string;
	href?: string;
	parent?: IntroNode | null;
	parentElement?: IntroNode | null;
	maxLength?: number;
	append(...nodes: IntroNode[]): void;
	replaceChildren(...nodes: IntroNode[]): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): IntroNode | null;
	querySelectorAll(selector: string): Iterable<IntroNode>;
	addEventListener(
		type: string,
		listener: (event: { preventDefault(): void; target?: unknown }) => void,
	): void;
	click(): void;
	focus(): void;
};

export type IntroDocument = {
	createElement(tag: string): IntroNode;
	getElementById(id: string): IntroNode | null;
};

function el(
	doc: IntroDocument,
	tag: string,
	className = "",
	text = "",
): IntroNode {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}

function action(
	node: IntroNode,
	name: string,
	extra?: Record<string, string>,
): IntroNode {
	node.setAttribute("data-intro-action", name);
	if (extra) {
		for (const key of Object.keys(extra)) {
			const value = extra[key];
			if (value !== undefined) node.setAttribute(key, value);
		}
	}
	return node;
}

function writeBody(node: IntroNode, text: string, markdown: boolean): void {
	if (markdown && "ownerDocument" in node) {
		node.className += " markdown-body";
		renderMarkdown(node, text, "");
		return;
	}
	node.textContent = text;
}

export function renderTranscript(
	messages: IntroNode,
	doc: IntroDocument,
	bubbles: IntroBubble[],
): void {
	messages.replaceChildren();
	for (const bubble of bubbles) {
		const article = el(doc, "article", "message " + bubble.role);
		article.setAttribute(
			"aria-label",
			bubble.role === "assistant" ? "Lina" : "나",
		);
		article.setAttribute("data-turn-id", bubble.turnId);
		const body = el(doc, "div", "message-body");
		if (bubble.state === "preparing" || bubble.state === "pending")
			body.textContent = "응답 준비 중";
		else if (bubble.state === "stopped")
			body.textContent = bubble.text || "응답 준비를 멈췄습니다.";
		else if (bubble.role === "assistant") writeBody(body, bubble.text, true);
		else body.textContent = bubble.text;
		const footer = el(doc, "div", "message-footer");
		const status = el(doc, "span", "message-status");
		if (bubble.state === "failed") {
			status.textContent =
				bubble.error === "interrupted"
					? "다시 연결됐어요. 이어서 답할 수 있습니다."
					: "응답을 완성하지 못했습니다. 대화는 남아 있어요.";
			status.className = "message-status warning";
			const retry = el(doc, "button", "text-button", "다시 시도");
			retry.setAttribute("type", "button");
			action(retry, "retry", { "data-request-id": bubble.requestId });
			footer.append(status, retry);
		} else if (bubble.state === "stopped") {
			status.textContent = "중단됨";
			const retry = el(doc, "button", "text-button", "다시 시도");
			retry.setAttribute("type", "button");
			action(retry, "retry", { "data-request-id": bubble.requestId });
			footer.append(status, retry);
		} else if (bubble.state === "pending") {
			status.textContent = "응답 준비 중";
			footer.append(status);
		}
		article.append(body, footer);
		messages.append(article);
	}
}

export function renderSummary(
	userRoot: IntroNode,
	personaRoot: IntroNode,
	doc: IntroDocument,
	room: IntroRoom | null,
): void {
	userRoot.replaceChildren();
	personaRoot.replaceChildren();
	if (!room) return;
	const userTitle = el(doc, "h3", "", "나에 대한 정리");
	const userList = el(doc, "dl", "intro-review");
	for (const field of USER_REVIEW_FIELDS) {
		const dt = el(doc, "dt", "", field.label);
		const dd = el(
			doc,
			"dd",
			"",
			room.data.user[field.key]?.trim() ||
				(field.key in (room.data.userSkipped ?? {}) ? "건너뜀" : "아직 없음"),
		);
		userList.append(dt, dd);
	}
	userRoot.append(userTitle, userList);
	const personaTitle = el(doc, "h3", "", "캐릭터");
	const personaList = el(doc, "dl", "intro-review");
	for (const field of PROFILE_REVIEW_FIELDS) {
		const dt = el(doc, "dt", "", field.label);
		const raw = room.data.profile[field.key];
		const value =
			typeof raw === "string"
				? field.key === "name"
					? displayName(raw === UNSPECIFIED ? "" : raw)
					: raw === UNSPECIFIED
						? "아직 없음"
						: raw
				: "아직 없음";
		personaList.append(dt, el(doc, "dd", "", value || "아직 없음"));
	}
	const interests = room.data.profile.interests.join(", ");
	personaList.append(
		el(doc, "dt", "", "관심사"),
		el(doc, "dd", "", interests || "아직 없음"),
	);
	for (const field of CHAPTER_REVIEW_FIELDS) {
		personaList.append(
			el(doc, "dt", "", field.label),
			el(doc, "dd", "", room.data.chapters[field.key].trim() || "아직 없음"),
		);
	}
	personaRoot.append(personaTitle, personaList);
}

export function renderProgress(
	node: IntroNode,
	room: IntroRoom | null,
	turnCount: number,
): void {
	if (room?.status !== "active") {
		node.textContent = "";
		return;
	}
	if (room.kind === "user") {
		const basics = userBasics(room.data.user, room.data.userSkipped);
		node.textContent = `기본 소개 ${basics.completed}/${basics.total} · 답하고 싶지 않은 내용은 건너뛸 수 있어요.`;
		return;
	}
	const target = turnTarget(room.kind, room.mode);
	node.textContent = `이야기 ${turnCount}회 · 약 ${target}회로 시작해요. 더 이야기하거나 지금 마칠 수 있어요.`;
}

export function renderMode(root: IntroNode, mode: InterviewMode): void {
	for (const button of root.querySelectorAll("[data-intro-mode]")) {
		const value = button.getAttribute("data-intro-mode");
		button.setAttribute("aria-pressed", String(value === mode));
	}
}

function reviewBlock(doc: IntroDocument, room: IntroRoom): IntroNode {
	const wrap = el(doc, "div", "intro-review-panel");
	wrap.append(
		el(doc, "h3", "", room.kind === "user" ? "내 소개" : "캐릭터 정리"),
	);
	const list = el(doc, "dl", "intro-review");
	if (room.kind === "user") {
		for (const field of USER_REVIEW_FIELDS) {
			list.append(
				el(doc, "dt", "", field.label),
				el(
					doc,
					"dd",
					"",
					room.data.user[field.key]?.trim() ||
						(field.key in (room.data.userSkipped ?? {})
							? "건너뜀"
							: "아직 없음"),
				),
			);
		}
	} else {
		for (const field of PROFILE_REVIEW_FIELDS) {
			const raw = room.data.profile[field.key];
			list.append(
				el(doc, "dt", "", field.label),
				el(
					doc,
					"dd",
					"",
					typeof raw === "string" && raw.trim() && raw !== UNSPECIFIED
						? raw
						: "아직 없음",
				),
			);
		}
		for (const field of CHAPTER_REVIEW_FIELDS) {
			list.append(
				el(doc, "dt", "", field.label),
				el(doc, "dd", "", room.data.chapters[field.key].trim() || "아직 없음"),
			);
		}
	}
	wrap.append(list);
	return wrap;
}

function shareLabel(
	doc: IntroDocument,
	shareUser: boolean,
	id: string,
): IntroNode {
	const label = el(doc, "label", "intro-share");
	const box = doc.createElement("input");
	box.setAttribute("type", "checkbox");
	box.id = id;
	box.checked = shareCheckbox(shareUser);
	label.append(
		box,
		el(
			doc,
			"span",
			"",
			"선택한 에이전트가 내 소개를 참고하도록 허용합니다. 끄면 기존 공유도 중지해요.",
		),
	);
	return label;
}

function legacyList(
	doc: IntroDocument,
	drafts: LegacyDraftRef[],
): IntroNode | null {
	if (!drafts.length) return null;
	const details = el(doc, "details", "intro-legacy");
	details.append(el(doc, "summary", "", "저장한 초안 이어가기"));
	const list = el(doc, "div", "intro-legacy-list");
	for (const draft of drafts) {
		const button = el(doc, "button", "text-button", displayName(draft.name));
		button.setAttribute("type", "button");
		action(button, "legacy", { "data-draft-id": draft.id });
		list.append(button);
	}
	details.append(list);
	return details;
}

export function renderPanel(
	panel: IntroNode,
	doc: IntroDocument,
	input: {
		snapshot: IntroSnapshot;
		reviewOpen: boolean;
		entry: IntroEntry | null;
		busy: boolean;
	},
): void {
	panel.replaceChildren();
	const room = input.snapshot.room;
	if (!room) return;
	if (room.status === "applying") {
		panel.append(el(doc, "p", "intro-lead", "적용하는 중"));
		const reload = el(doc, "button", "secondary-button", "적용 다시 시도");
		reload.setAttribute("type", "button");
		action(reload, "resume");
		reload.disabled = input.busy;
		const restart = el(doc, "button", "text-button", "최신 설정으로 다시 시작");
		restart.setAttribute("type", "button");
		action(restart, "restart");
		restart.disabled = input.busy;
		panel.append(reload, restart);
		return;
	}
	if (room.status === "done") return;
	if (room.status === "choices") {
		panel.append(el(doc, "p", "intro-lead", "이제 누구와 함께할까요?"));
		panel.append(shareLabel(doc, input.snapshot.shareUser, "intro-share-user"));
		const list = el(doc, "div", "intro-choices");
		for (const preset of input.snapshot.presets.filter(
			(p) => p.id === "lina",
		)) {
			const button = el(doc, "button", "intro-choice");
			button.setAttribute("type", "button");
			action(button, "choose", { "data-preset-id": preset.id });
			button.append(
				el(doc, "strong", "", "리나로 시작"),
				el(
					doc,
					"small",
					"",
					"방금 나눈 소개를 바탕으로, 일상 이야기와 필요한 일을 함께해요.",
				),
			);
			list.append(button);
		}
		const custom = el(doc, "button", "intro-choice");
		custom.setAttribute("type", "button");
		action(custom, "choose-custom");
		custom.append(
			el(doc, "strong", "", "내 에이전트 만들기"),
			el(doc, "small", "", "리나와 이름부터 성격까지 함께 정해요"),
		);
		list.append(custom);
		panel.append(list);
		panel.append(
			el(
				doc,
				"p",
				"intro-later",
				"특정 분야를 맡길 에이전트는 나중에 사이드바의 +에서 템플릿으로 추가할 수 있어요.",
			),
		);
		const legacy = legacyList(doc, input.entry?.legacyDrafts ?? []);
		if (legacy) panel.append(legacy);
		return;
	}
	const skip = el(doc, "button", "text-button", "건너뛰기");
	skip.setAttribute("type", "button");
	action(skip, "skip");
	skip.disabled = input.busy;
	if (!input.reviewOpen) {
		const review = el(
			doc,
			"button",
			room.data.ready ? "secondary-button" : "text-button",
			room.kind === "persona"
				? "만들 에이전트 보기"
				: room.data.ready
					? "소개 확인하고 시작"
					: "현재 소개 보기",
		);
		review.setAttribute("type", "button");
		action(review, "review");
		review.disabled = input.busy;
		panel.append(skip, review);
		const legacy = legacyList(doc, input.entry?.legacyDrafts ?? []);
		if (legacy) panel.append(legacy);
		return;
	}
	panel.append(reviewBlock(doc, room));
	if (room.kind === "persona")
		panel.append(shareLabel(doc, input.snapshot.shareUser, "intro-share-user"));
	const confirm = el(
		doc,
		"button",
		"secondary-button",
		room.kind === "user" ? "이 소개로 시작" : "만들고 대화 시작",
	);
	confirm.setAttribute("type", "button");
	action(confirm, room.kind === "user" ? "confirm-user" : "confirm-persona");
	confirm.disabled = input.busy;
	panel.append(skip, confirm);
}

export function answeredCountFromSnapshot(snapshot: IntroSnapshot): number {
	return answeredTurnCount(snapshot.turns);
}

import { userBasics } from "../../lina-core/src/onboarding/user-basics.ts";
