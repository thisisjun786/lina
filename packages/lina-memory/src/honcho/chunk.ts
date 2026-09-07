import { createHash } from "node:crypto";

// Conservative UTF-8 byte cap per part: below the 25000-char server default and the
// BUZZ 1800-token embedding input cap even when every byte is its own token.
export const PART_MAX_BYTES = 1500;

// Honcho strips NUL server-side; stripping locally keeps the local hash identical to
// what the server stores. The unsanitized original stays in the local entry store.
export function sanitizeNul(text: string): string {
	return text.replaceAll("\0", "");
}

export function contentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function chunkText(
	text: string,
): { content: string; contentHash: string }[] {
	const clean = sanitizeNul(text);
	const parts: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const codePoint of clean) {
		const bytes = Buffer.byteLength(codePoint, "utf8");
		if (currentBytes + bytes > PART_MAX_BYTES) {
			parts.push(current);
			current = "";
			currentBytes = 0;
		}
		current += codePoint;
		currentBytes += bytes;
	}
	if (current.length > 0) parts.push(current);
	return parts.map((content) => ({
		content,
		contentHash: contentHash(content),
	}));
}
