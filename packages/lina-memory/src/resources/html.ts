import { fileURLToPath } from "node:url";
import {
	DOCUMENT_MAX_CHARS,
	runDocumentProcess,
} from "../../../lina-core/src/attachments/document.ts";
import { AttachmentError } from "../../../lina-core/src/attachments/types.ts";
import { ATTACHMENT_MAX_BYTES } from "../../../lina-core/src/attachments/validation.ts";

const PYTHON = "/usr/bin/python3";
const HTML_SCRIPT = fileURLToPath(
	new URL("./scripts/html_text.py", import.meta.url),
);

export function isResourceHtml(mime: string): boolean {
	return mime === "text/html";
}

function clampChars(
	text: string,
	limit: number,
): { text: string; cut: boolean } {
	if (text.length <= limit) return { text, cut: false };
	let end = limit;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return { text: text.slice(0, end), cut: true };
}

export async function extractHtml(
	bytes: Uint8Array,
	signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES)
		throw new AttachmentError("size-limit", "Document exceeds the size bound");
	if (bytes.includes(0))
		throw new AttachmentError("unsupported-type", "HTML contains a NUL byte");
	signal.throwIfAborted();
	const result = await runDocumentProcess(
		PYTHON,
		[
			"-I",
			"-S",
			HTML_SCRIPT,
			String(DOCUMENT_MAX_CHARS),
			String(ATTACHMENT_MAX_BYTES),
		],
		bytes,
		signal,
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(result.stdout));
	} catch {
		throw new AttachmentError(
			"unsupported-type",
			result.code === 0
				? "Document extractor produced invalid output"
				: "Document extractor failed",
		);
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new AttachmentError("unsupported-type", "Document extractor failed");
	const object = parsed as {
		error?: unknown;
		text?: unknown;
		truncated?: unknown;
	};
	if (typeof object.error === "string") {
		if (/not valid UTF-8/iu.test(object.error))
			throw new TypeError("HTML is not valid UTF-8");
		throw new AttachmentError("unsupported-type", object.error.slice(0, 200));
	}
	if (result.code !== 0)
		throw new AttachmentError("unsupported-type", "Document extractor failed");
	if (typeof object.text !== "string" || typeof object.truncated !== "boolean")
		throw new AttachmentError(
			"unsupported-type",
			"Document extractor produced invalid output",
		);
	const clamped = clampChars(object.text, DOCUMENT_MAX_CHARS);
	return {
		text: clamped.text,
		truncated: object.truncated || clamped.cut,
	};
}
