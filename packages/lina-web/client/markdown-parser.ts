import { parseInline } from "./markdown-inline.ts";
import {
	MAX_DEPTH,
	MAX_INPUT_LENGTH,
	type MarkdownInlineToken,
	type MarkdownToken,
	ParseLimitError,
	TokenBudget,
} from "./markdown-types.ts";

type SourceLine = {
	readonly text: string;
	readonly raw: string;
	readonly ending: string;
};

export function parseMarkdown(text: string): MarkdownToken[] {
	if (text.length > MAX_INPUT_LENGTH) return [{ type: "plain", value: text }];

	try {
		return parseBlocks(text, new TokenBudget(), 0);
	} catch (error) {
		if (error instanceof ParseLimitError)
			return [{ type: "plain", value: text }];
		throw error;
	}
}

function parseBlocks(
	source: string,
	budget: TokenBudget,
	depth: number,
): MarkdownToken[] {
	if (depth > MAX_DEPTH)
		throw new ParseLimitError("Markdown nesting limit exceeded");

	const lines = splitLines(source);
	const tokens: MarkdownToken[] = [];
	const paragraph: string[] = [];

	const flushParagraph = (): void => {
		if (paragraph.length === 0) return;
		const children = parseInline(paragraph.join(""), budget, depth);
		budget.take();
		tokens.push({ type: "paragraph", children });
		paragraph.length = 0;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) continue;
		if (line.text.trim() === "") {
			flushParagraph();
			continue;
		}

		const fence = openingFence(line.text);
		if (fence !== undefined) {
			flushParagraph();
			let value = "";
			let cursor = index + 1;
			let closed = false;
			while (cursor < lines.length) {
				const contentLine = lines[cursor];
				if (contentLine === undefined) break;
				if (closingFence(contentLine.text, fence.character, fence.length)) {
					closed = true;
					break;
				}
				value += contentLine.raw;
				cursor += 1;
			}
			budget.take();
			const language = fence.info.trim().split(/\s+/u)[0];
			tokens.push(
				language === undefined || language === ""
					? { type: "code", value }
					: { type: "code", value, language },
			);
			index = closed ? cursor : lines.length;
			continue;
		}

		const heading = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u.exec(line.text);
		if (heading !== null) {
			flushParagraph();
			budget.take();
			tokens.push({
				type: "heading",
				level: heading[2]?.length as 1 | 2 | 3 | 4 | 5 | 6,
				children: parseInline(heading[3] ?? "", budget, depth),
			});
			continue;
		}

		const quote = /^ {0,3}>[ \t]?(.*)$/u.exec(line.text);
		if (quote !== null) {
			flushParagraph();
			const quoted: string[] = [];
			let cursor = index;
			while (cursor < lines.length) {
				const quotedLine = lines[cursor];
				const match =
					quotedLine === undefined
						? null
						: /^ {0,3}>[ \t]?(.*)$/u.exec(quotedLine.text);
				if (match === null || quotedLine === undefined) break;
				quoted.push(`${match[1] ?? ""}${quotedLine.ending}`);
				cursor += 1;
			}
			budget.take();
			tokens.push({
				type: "quote",
				children: parseBlocks(quoted.join(""), budget, depth + 1),
			});
			index = cursor - 1;
			continue;
		}

		const list = listItem(line.text);
		if (list !== undefined) {
			flushParagraph();
			const items: MarkdownInlineToken[][] = [];
			let cursor = index;
			while (cursor < lines.length) {
				const itemLine = lines[cursor];
				const item =
					itemLine === undefined ? undefined : listItem(itemLine.text);
				if (item === undefined || item.ordered !== list.ordered) break;
				budget.take();
				items.push(parseInline(item.value, budget, depth));
				cursor += 1;
			}
			budget.take();
			tokens.push({ type: "list", ordered: list.ordered, items });
			index = cursor - 1;
			continue;
		}

		paragraph.push(line.raw);
	}
	flushParagraph();
	return tokens;
}

function splitLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== "\n" && source[index] !== "\r") continue;
		const ending =
			source[index] === "\r" && source[index + 1] === "\n"
				? "\r\n"
				: (source[index] ?? "");
		const text = source.slice(start, index);
		lines.push({ text, raw: text + ending, ending });
		start = index + ending.length;
		if (ending === "\r\n") index += 1;
	}
	if (start < source.length) {
		const text = source.slice(start);
		lines.push({ text, raw: text, ending: "" });
	}
	return lines;
}

function openingFence(value: string):
	| {
			readonly character: "`" | "~";
			readonly length: number;
			readonly info: string;
	  }
	| undefined {
	const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/u.exec(value);
	if (match === null || match[2] === undefined) return undefined;
	if (match[2][0] === "`" && match[3]?.includes("`") === true) return undefined;
	return {
		character: match[2][0] as "`" | "~",
		length: match[2].length,
		info: match[3] ?? "",
	};
}

function closingFence(
	value: string,
	character: "`" | "~",
	length: number,
): boolean {
	const prefix = new RegExp(`^ {0,3}${character}{${length},}[ \\t]*$`, "u");
	return prefix.test(value);
}

function listItem(
	value: string,
): { readonly ordered: boolean; readonly value: string } | undefined {
	const unordered = /^ {0,3}[-+*][ \t]+(.*)$/u.exec(value);
	if (unordered !== null) return { ordered: false, value: unordered[1] ?? "" };
	const ordered = /^ {0,3}\d+[.)][ \t]+(.*)$/u.exec(value);
	if (ordered !== null) return { ordered: true, value: ordered[1] ?? "" };
	return undefined;
}
