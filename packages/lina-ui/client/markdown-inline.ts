import {
	MAX_DEPTH,
	type MarkdownInlineToken,
	ParseLimitError,
	type TokenBudget,
} from "./markdown-types.ts";

const UUID =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IMAGE_PREVIEW = new RegExp(
	`^/api/attachments/${UUID}/preview\\?sessionId=(${UUID})$`,
	"u",
);
type LinkMatch = {
	readonly end: number;
	readonly label: string;
	readonly destination: string;
	readonly source: string;
};

export function parseInline(
	source: string,
	budget: TokenBudget,
	depth: number,
): MarkdownInlineToken[] {
	if (depth > MAX_DEPTH)
		throw new ParseLimitError("Markdown nesting limit exceeded");

	const tokens: MarkdownInlineToken[] = [];
	let plainStart = 0;
	let index = 0;
	const flushPlain = (end: number): void => {
		if (end <= plainStart) return;
		budget.take();
		tokens.push({ type: "text", value: source.slice(plainStart, end) });
	};

	while (index < source.length) {
		if (source[index] === "!" && source[index + 1] === "[") {
			const image = linkAt(source, index + 1);
			if (image !== undefined) {
				const preview = IMAGE_PREVIEW.exec(image.destination);
				// Match the raw URL exactly: never normalize paths, queries or whitespace.
				if (
					preview !== null &&
					preview[0] === image.destination &&
					preview[1] !== undefined
				) {
					flushPlain(index);
					budget.take();
					tokens.push({
						type: "attachment-image",
						src: image.destination,
						alt: image.label,
						sessionId: preview[1],
						source: `!${image.source}`,
					});
					plainStart = image.end;
				}
				index = image.end;
				continue;
			}
		}

		const codeLength = runLength(source, index, "`");
		if (codeLength > 0) {
			const marker = "`".repeat(codeLength);
			const close = source.indexOf(marker, index + codeLength);
			if (close > index + codeLength) {
				flushPlain(index);
				budget.take();
				tokens.push({
					type: "inline-code",
					value: source.slice(index + codeLength, close),
				});
				index = close + codeLength;
				plainStart = index;
				continue;
			}
			index += codeLength; // Keep unmatched runs as text without rescanning every suffix.
			continue;
		}

		const emphasis = source.slice(index, index + 2);
		if (emphasis === "**" || emphasis === "__") {
			const close = source.indexOf(emphasis, index + 2);
			if (close > index + 2) {
				flushPlain(index);
				const children = parseInline(
					source.slice(index + 2, close),
					budget,
					depth + 1,
				);
				budget.take();
				tokens.push({ type: "strong", children });
				index = close + 2;
				plainStart = index;
				continue;
			}
		}

		if (source[index] === "[") {
			const link = linkAt(source, index);
			if (link !== undefined) {
				const kind = classifyDestination(link.destination.trim());
				if (kind !== undefined) {
					flushPlain(index);
					const children = parseInline(link.label, budget, depth + 1);
					budget.take();
					if (kind.type === "link") {
						tokens.push({
							type: "link",
							href: kind.href,
							children,
							source: link.source,
						});
					} else {
						tokens.push({
							type: "attachment",
							href: kind.href,
							attachmentId: kind.attachmentId,
							sessionId: kind.sessionId,
							children,
							source: link.source,
						});
					}
					index = link.end;
					plainStart = index;
					continue;
				}
				index = link.end;
				continue;
			}
		}

		index += 1;
	}

	flushPlain(source.length);
	return tokens;
}

function linkAt(source: string, start: number): LinkMatch | undefined {
	const labelEnd = source.indexOf("](", start + 1);
	if (labelEnd < 0) return undefined;
	const end = source.indexOf(")", labelEnd + 2);
	if (end < 0) return undefined;
	return {
		end: end + 1,
		label: source.slice(start + 1, labelEnd),
		destination: source.slice(labelEnd + 2, end),
		source: source.slice(start, end + 1),
	};
}

function classifyDestination(destination: string):
	| { readonly type: "link"; readonly href: string }
	| {
			readonly type: "attachment";
			readonly href: string;
			readonly attachmentId: string;
			readonly sessionId: string;
	  }
	| undefined {
	if (hasControlCharacters(destination) || destination === "") return undefined;
	const attachment = new RegExp(
		`^/api/attachments/(${UUID})\\?sessionId=([^&#?]+)$`,
		"iu",
	).exec(destination);
	if (
		attachment !== null &&
		attachment[1] !== undefined &&
		attachment[2] !== undefined
	) {
		let sessionId: string;
		try {
			sessionId = decodeURIComponent(attachment[2]);
		} catch {
			return undefined;
		}
		if (sessionId === "") return undefined;
		return {
			type: "attachment",
			href: destination,
			attachmentId: attachment[1],
			sessionId,
		};
	}

	const protocol = /^([a-z][a-z\d+.-]*):/iu
		.exec(destination)?.[1]
		?.toLowerCase();
	if (protocol !== "http" && protocol !== "https" && protocol !== "mailto")
		return undefined;
	try {
		const parsed = new URL(destination);
		if (parsed.protocol.slice(0, -1).toLowerCase() !== protocol)
			return undefined;
	} catch {
		return undefined;
	}
	return { type: "link", href: destination };
}

function runLength(source: string, start: number, character: string): number {
	let length = 0;
	while (source[start + length] === character) length += 1;
	return length;
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}
