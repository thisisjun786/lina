import type { ChatMessage } from "./model.ts";
import { toolSummary } from "./tool-label.ts";

/** Structural subset of DOM elements used here; real DOM elements satisfy it. */
export interface ToolPart {
	className: string;
	textContent: string | null;
}
export interface ToolNode {
	querySelector(selector: string): ToolPart | null;
}
export interface ToolElement extends ToolNode, ToolPart {
	type?: string;
	open?: boolean;
	append(...children: ToolElement[]): void;
	addEventListener(type: string, listener: () => void): void;
}
interface ToolDocument {
	createElement(tagName: string): ToolElement;
}
function getDocument(): ToolDocument {
	const dom = (globalThis as unknown as { document?: ToolDocument }).document;
	if (dom === undefined)
		throw new Error("Tool rendering requires a browser document");
	return dom;
}

/**
 * A persisted tool result is a collapsed disclosure row: tool name and status
 * in the summary, raw output as textContent only under the disclosure. The
 * node is reused across renders so the open state and expanded pages persist.
 */
export function createToolNode(
	message: ChatMessage,
	expand: ((id: string) => void) | undefined,
): ToolElement {
	const dom = getDocument();
	const details = dom.createElement("details");
	details.className = "message tool tool-result";
	const summary = dom.createElement("summary");
	const label = dom.createElement("span");
	label.className = "tool-label";
	const badge = dom.createElement("span");
	badge.className = "tool-badge";
	summary.append(label, badge);
	const body = dom.createElement("div");
	body.className = "message-body";
	const footer = dom.createElement("div");
	footer.className = "message-footer";
	const status = dom.createElement("span");
	status.className = "message-status";
	footer.append(status);
	if (expand) {
		const more = dom.createElement("button");
		more.type = "button";
		more.className = "message-more";
		more.textContent = "원문 더 보기";
		more.addEventListener("click", () => expand(message.id));
		footer.append(more);
	}
	details.append(summary, body, footer);
	updateToolNode(details, message);
	return details;
}

export function updateToolNode(node: ToolNode, message: ChatMessage): void {
	const { label, badge, tone } = toolSummary(message.tool);
	const labelNode = node.querySelector(".tool-label");
	if (labelNode && labelNode.textContent !== label)
		labelNode.textContent = label;
	const badgeNode = node.querySelector(".tool-badge");
	if (badgeNode) {
		if (badgeNode.textContent !== badge) badgeNode.textContent = badge;
		const className = `tool-badge${tone ? ` ${tone}` : ""}`;
		if (badgeNode.className !== className) badgeNode.className = className;
	}
}
