import { parseMarkdown } from "./markdown-parser.ts";
import type {
	MarkdownContainer,
	MarkdownDocument,
	MarkdownElement,
	MarkdownInlineToken,
	MarkdownNode,
	MarkdownToken,
} from "./markdown-types.ts";

export { parseMarkdown } from "./markdown-parser.ts";
export type {
	MarkdownContainer,
	MarkdownInlineToken,
	MarkdownToken,
} from "./markdown-types.ts";
export function renderMarkdown(
	container: unknown,
	text: string,
	sessionId?: string,
): void {
	if (
		typeof container !== "object" ||
		container === null ||
		!("replaceChildren" in container) ||
		typeof container.replaceChildren !== "function"
	)
		throw new Error("Markdown container missing");
	const target = container as MarkdownContainer;
	const dom = getDocument();
	const fragment = dom.createDocumentFragment();
	for (const token of parseMarkdown(text)) {
		fragment.append(renderBlock(dom, token, sessionId));
	}
	target.replaceChildren(fragment);
}

function renderBlock(
	dom: MarkdownDocument,
	token: MarkdownToken,
	sessionId: string | undefined,
): MarkdownNode {
	if (token.type === "plain") return dom.createTextNode(token.value);
	if (token.type === "paragraph")
		return renderInlineBlock(dom, "p", token.children, sessionId);
	if (token.type === "heading")
		return renderInlineBlock(dom, `h${token.level}`, token.children, sessionId);
	if (token.type === "quote") {
		const blockquote = dom.createElement("blockquote");
		blockquote.className = "markdown-quote";
		for (const child of token.children)
			blockquote.append(renderBlock(dom, child, sessionId));
		return blockquote;
	}
	if (token.type === "list") {
		const list = dom.createElement(token.ordered ? "ol" : "ul");
		list.className = "markdown-list";
		for (const item of token.items) {
			const row = dom.createElement("li");
			appendInline(dom, row, item, sessionId);
			list.append(row);
		}
		return list;
	}

	const wrapper = dom.createElement("div");
	wrapper.className = "markdown-code-block";
	const toolbar = dom.createElement("div");
	toolbar.className = "markdown-code-toolbar";
	if (token.language !== undefined) {
		const language = dom.createElement("span");
		language.className = "markdown-code-language";
		language.textContent = token.language;
		toolbar.append(language);
	}
	const button = dom.createElement("button");
	button.type = "button";
	button.className = "markdown-copy-button";
	button.textContent = "복사";
	const status = dom.createElement("span");
	status.className = "markdown-copy-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	status.textContent = "";
	button.addEventListener("click", () => {
		void copyCode(token.value, status);
	});
	toolbar.append(button, status);
	const pre = dom.createElement("pre");
	const code = dom.createElement("code");
	code.textContent = token.value;
	pre.append(code);
	wrapper.append(toolbar, pre);
	return wrapper;
}

function renderInlineBlock(
	dom: MarkdownDocument,
	tagName: string,
	tokens: MarkdownInlineToken[],
	sessionId: string | undefined,
): MarkdownElement {
	const block = dom.createElement(tagName);
	appendInline(dom, block, tokens, sessionId);
	return block;
}

function appendInline(
	dom: MarkdownDocument,
	parent: MarkdownElement,
	tokens: MarkdownInlineToken[],
	sessionId: string | undefined,
): void {
	for (const token of tokens) {
		if (token.type === "text" || token.type === "inline-code") {
			if (token.type === "inline-code") {
				const code = dom.createElement("code");
				code.className = "markdown-inline-code";
				code.textContent = token.value;
				parent.append(code);
			} else parent.append(dom.createTextNode(token.value));
			continue;
		}
		if (token.type === "strong") {
			const strong = dom.createElement("strong");
			appendInline(dom, strong, token.children, sessionId);
			parent.append(strong);
			continue;
		}
		if (token.type === "link") {
			const link = dom.createElement("a");
			link.setAttribute("href", token.href);
			link.setAttribute("rel", "noopener noreferrer");
			link.setAttribute("target", "_blank");
			appendInline(dom, link, token.children, sessionId);
			parent.append(link);
			continue;
		}
		if (sessionId !== undefined && token.sessionId === sessionId) {
			const link = dom.createElement("a");
			link.className = "markdown-attachment-link";
			link.setAttribute("href", token.href);
			appendInline(dom, link, token.children, sessionId);
			parent.append(link);
		} else parent.append(dom.createTextNode(token.source));
	}
}

async function copyCode(value: string, status: MarkdownElement): Promise<void> {
	try {
		const clipboard = (
			globalThis as {
				navigator?: { clipboard?: { writeText(value: string): Promise<void> } };
			}
		).navigator?.clipboard;
		if (clipboard === undefined) throw new Error("Clipboard API unavailable");
		await clipboard.writeText(value);
		status.textContent = "복사됨";
	} catch {
		status.textContent = "복사 실패";
	}
}

function getDocument(): MarkdownDocument {
	const dom = (globalThis as unknown as { document?: MarkdownDocument })
		.document;
	if (dom === undefined)
		throw new Error("Markdown rendering requires a browser document");
	return dom;
}
