/** Limit search input before it reaches the configured embedding service. */
export function queryPrefix(text: string): string {
	let prefix = "",
		bytes = 0;
	for (const character of text) {
		if (character === "\0") continue;
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > 1500) break;
		prefix += character;
		bytes += size;
	}
	return prefix;
}

/** The shared wire contract measures UTF-16 units; avoid half a surrogate pair. */
export function recallPrefix(text: string): string {
	let end = Math.min(4096, text.length);
	if (end < text.length && end > 0) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end--;
	}
	return text.slice(0, end);
}
