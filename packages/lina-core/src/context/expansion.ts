import { archiveText } from "./archive.ts";
import {
	EXPAND_SOURCES_MAX,
	EXPAND_TEXT_MAX_CHARS,
	type ExpandOptions,
	type ExpandPage,
	type LookupEntry,
	type SourceRef,
	type SummaryNode,
} from "./types.ts";
import { validRef } from "./validation.ts";

function validOffset(value: unknown, what: string): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`invalid expand ${what}`);
	return value as number;
}

/** Slices without splitting a surrogate pair at the page boundary. */
function page(
	text: string,
	offset: number,
	max: number,
): { text: string; next: number | null } {
	if (offset > text.length) throw new Error("invalid expand offset");
	let end = Math.min(text.length, offset + max);
	if (end < text.length && end > offset) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return {
		text: text.slice(offset, end),
		next: end < text.length ? end : null,
	};
}

export function expandSource(
	ref: SourceRef,
	options: ExpandOptions,
	lookupEntry: LookupEntry,
	get: (id: string) => SummaryNode | undefined,
): ExpandPage {
	const target = validRef(ref);
	const offset = validOffset(options.offset, "offset");
	const sourceOffset = validOffset(options.sourceOffset, "sourceOffset");
	if (target.kind === "entry") {
		const entry = lookupEntry(target.id);
		if (!entry) throw new Error(`unknown source entry: ${target.id}`);
		if (sourceOffset !== 0) throw new Error("invalid expand sourceOffset");
		const slice = page(archiveText(entry), offset, EXPAND_TEXT_MAX_CHARS);
		return {
			ref: target,
			text: slice.text,
			nextOffset: slice.next,
			sources: [],
			nextSourceOffset: null,
		};
	}
	const node = get(target.id);
	if (!node) throw new Error(`unknown source summary: ${target.id}`);
	if (sourceOffset > node.sources.length)
		throw new Error("invalid expand sourceOffset");
	const slice = page(node.text, offset, EXPAND_TEXT_MAX_CHARS);
	const end = Math.min(node.sources.length, sourceOffset + EXPAND_SOURCES_MAX);
	return {
		ref: target,
		text: slice.text,
		nextOffset: slice.next,
		sources: node.sources.slice(sourceOffset, end),
		nextSourceOffset: end < node.sources.length ? end : null,
	};
}
