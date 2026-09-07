import type {
	ChatMessage,
	ChatModel,
	MessageStatus,
} from "../../lina-client/src/model.ts";
import { renderUserBody } from "./attachments.ts";
import { renderMarkdown } from "./markdown.ts";

export function element<T extends HTMLElement>(
	id: string,
	type: { new (): T },
): T {
	const found = document.getElementById(id);
	if (!(found instanceof type))
		throw new Error(`Missing interface element: ${id}`);
	return found;
}

export function setText(node: Element, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

const STATUS: Record<MessageStatus, string> = {
	pending: "전송 중",
	requested: "",
	unconfirmed: "전송 결과 미확인",
	streaming: "응답 중",
	complete: "",
	partial: "일부 응답",
	saved: "",
	interrupted: "중단됨",
	rejected: "요청을 실행하지 못함",
};

export function createRenderer(
	source: ChatModel | (() => ChatModel),
	restore: (text: string) => void,
	expand?: (id: string) => void,
	sessionId: () => string | undefined = () => undefined,
) {
	const messages = element("messages", HTMLDivElement);
	const scroll = element("conversation-scroll", HTMLDivElement);
	const getModel = () => (typeof source === "function" ? source() : source);
	let bound = getModel();
	const nodes = new Map<string, HTMLElement>();
	const rendered = new WeakMap<Element, string>();

	return () => {
		const model = getModel();
		if (bound !== model) {
			messages.replaceChildren();
			nodes.clear();
			bound = model;
		}
		const follow =
			scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
		element("welcome", HTMLElement).hidden = model.messages.length > 0;
		if (messages.getAttribute("aria-busy") !== String(model.running))
			messages.setAttribute("aria-busy", String(model.running));
		const visible = model.messages.filter((message) => message.role !== "tool");
		const present = new Set(visible.map((message) => message.id));
		for (const [id, node] of nodes)
			if (!present.has(id)) {
				node.remove();
				nodes.delete(id);
			}
		for (const [index, message] of visible.entries()) {
			let node = nodes.get(message.id);
			if (node === undefined) {
				node = messageNode(
					message,
					() => {
						const current = model.messages.find(
							(item) => item.id === message.id,
						);
						if (current) restore(current.text);
					},
					expand,
				);
				nodes.set(message.id, node);
			}
			if (messages.children[index] !== node)
				messages.insertBefore(node, messages.children[index] ?? null);
			const live = message.status === "streaming" ? "off" : "polite";
			if (node.getAttribute("aria-live") !== live)
				node.setAttribute("aria-live", live);
			const more = node.querySelector<HTMLButtonElement>(".message-more");
			if (more)
				more.hidden =
					message.nextOffset === undefined || message.nextOffset === null;
			const body = node.querySelector(".message-body");
			if (
				body !== null &&
				rendered.get(body) !== `${sessionId()}\n${message.text}`
			) {
				if (message.role === "assistant") {
					body.classList.add("markdown-body");
					renderMarkdown(body, message.text, sessionId());
				} else if (message.role === "user")
					renderUserBody(body, message.text, sessionId());
				else body.textContent = message.text;
				rendered.set(body, `${sessionId()}\n${message.text}`);
			}
			const status = node.querySelector<HTMLElement>(".message-status");
			if (status !== null) {
				setText(status, STATUS[message.status]);
				status.hidden = STATUS[message.status].length === 0;
				status.className = `message-status${message.status === "partial" || message.status === "unconfirmed" ? " warning" : ""}`;
			}
			const reuse = node.querySelector<HTMLButtonElement>(".message-reuse");
			if (reuse)
				reuse.hidden = !["unconfirmed", "interrupted", "rejected"].includes(
					message.status,
				);
			const footer = node.querySelector<HTMLElement>(".message-footer");
			if (footer)
				footer.hidden = Array.from(footer.children).every(
					(child) => child instanceof HTMLElement && child.hidden,
				);
		}
		if (follow) scroll.scrollTop = scroll.scrollHeight;
	};
}

function messageNode(
	message: ChatMessage,
	restore: () => void,
	expand?: (id: string) => void,
): HTMLElement {
	const article = document.createElement("article");
	article.className = `message ${message.role}`;
	article.dataset["messageId"] = message.id;
	article.setAttribute(
		"aria-label",
		message.role === "assistant" ? "에이전트 메시지" : "나",
	);
	const body = document.createElement("div");
	body.className = "message-body";
	const footer = document.createElement("div");
	footer.className = "message-footer";
	const status = document.createElement("span");
	status.className = "message-status";
	footer.append(status);
	if (expand) {
		const more = document.createElement("button");
		more.type = "button";
		more.className = "message-more";
		more.textContent = "원문 더 보기";
		more.addEventListener("click", () => expand(message.id));
		footer.append(more);
	}
	if (message.role === "user") {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "message-reuse";
		button.textContent = "메시지 수정";
		button.addEventListener("click", restore);
		footer.append(button);
	}
	article.append(body, footer);
	return article;
}
