export const MAX_INPUT_LENGTH = 65_536;
export const MAX_TOKENS = 4096;
export const MAX_DEPTH = 8;
export interface MarkdownContainer {
	replaceChildren(...children: MarkdownNode[]): void;
}

export interface MarkdownNode {
	append(...children: MarkdownNode[]): void;
}

export interface MarkdownElement extends MarkdownNode {
	className: string;
	type: string;
	textContent: string;
	setAttribute(name: string, value: string): void;
	addEventListener(type: string, listener: () => void): void;
}

export interface MarkdownDocument {
	createElement(tagName: string): MarkdownElement;
	createTextNode(value: string): MarkdownNode;
	createDocumentFragment(): MarkdownNode;
}

export type MarkdownInlineToken =
	| { readonly type: "text"; readonly value: string }
	| { readonly type: "inline-code"; readonly value: string }
	| { readonly type: "strong"; readonly children: MarkdownInlineToken[] }
	| {
			readonly type: "link";
			readonly href: string;
			readonly children: MarkdownInlineToken[];
			readonly source: string;
	  }
	| {
			readonly type: "attachment";
			readonly href: string;
			readonly attachmentId: string;
			readonly sessionId: string;
			readonly children: MarkdownInlineToken[];
			readonly source: string;
	  };

export type MarkdownToken =
	| { readonly type: "plain"; readonly value: string }
	| { readonly type: "paragraph"; readonly children: MarkdownInlineToken[] }
	| {
			readonly type: "heading";
			readonly level: 1 | 2 | 3 | 4 | 5 | 6;
			readonly children: MarkdownInlineToken[];
	  }
	| {
			readonly type: "list";
			readonly ordered: boolean;
			readonly items: MarkdownInlineToken[][];
	  }
	| { readonly type: "quote"; readonly children: MarkdownToken[] }
	| {
			readonly type: "code";
			readonly value: string;
			readonly language?: string;
	  };

export class ParseLimitError extends Error {}

export class TokenBudget {
	private count = 0;

	take(): void {
		this.count += 1;
		if (this.count > MAX_TOKENS)
			throw new ParseLimitError("Markdown token limit exceeded");
	}
}
