import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectDocument } from "./document-container.ts";
import {
	AttachmentError,
	type DocumentExtraction,
	isDocumentMime,
} from "./types.ts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_READ_CHARS } from "./validation.ts";

/**
 * Shared async adapter that turns owned document bytes into bounded text.
 * Tools and the HTTP preview both call extractDocument(); raw bytes in the
 * store are never touched. Extraction runs in a child process with no shell,
 * a wall-clock deadline, stdout/stderr caps, and abort-kill.
 */

export const DOCUMENT_MAX_CHARS = 256 * 1024;
export const DOCUMENT_MAX_PAGES = 2000;
export const DOCUMENT_TIMEOUT_MS = 20_000;
const CHILD_STDOUT_BYTES = DOCUMENT_MAX_CHARS * 4 + 64 * 1024;
const CHILD_STDERR_BYTES = 16 * 1024;
const PDFTOTEXT = "/usr/bin/pdftotext";
const PYTHON = "/usr/bin/python3";
const OFFICE_SCRIPT = fileURLToPath(
	new URL("./scripts/office_text.py", import.meta.url),
);
const PAGE_BREAK = "\f";

export interface DocumentPage {
	offset: number;
	text: string;
	nextOffset: number | null;
}

interface ChildResult {
	code: number | null;
	stdout: Uint8Array;
	stderr: string;
	stdoutTruncated: boolean;
}

export function runDocumentProcess(
	command: string,
	args: string[],
	input: Uint8Array,
	signal: AbortSignal,
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const child = spawn(
			"/usr/bin/prlimit",
			[
				"--as=536870912",
				"--cpu=20",
				"--fsize=0",
				"--nproc=0",
				"--",
				command,
				...args,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
				cwd: "/",
				windowsHide: true,
			},
		);
		const outChunks: Uint8Array[] = [];
		let outBytes = 0;
		let stdoutTruncated = false;
		let stderr = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			fn();
		};
		const fail = (error: unknown) =>
			finish(() => {
				if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
				reject(error);
			});
		const onAbort = () =>
			fail(
				signal.reason instanceof Error
					? signal.reason
					: new AttachmentError("deadline", "Document extraction aborted"),
			);
		const timer = setTimeout(
			() =>
				fail(new AttachmentError("deadline", "Document extraction timed out")),
			DOCUMENT_TIMEOUT_MS,
		);
		signal.addEventListener("abort", onAbort, { once: true });
		child.on("error", fail);
		child.stdout.on("data", (chunk: Uint8Array) => {
			if (stdoutTruncated) return;
			const room = CHILD_STDOUT_BYTES - outBytes;
			if (chunk.byteLength > room) {
				outChunks.push(chunk.subarray(0, room));
				outBytes += room;
				stdoutTruncated = true;
				child.kill("SIGKILL");
				return;
			}
			outChunks.push(chunk);
			outBytes += chunk.byteLength;
		});
		child.stderr.on("data", (chunk: Uint8Array) => {
			if (stderr.length < CHILD_STDERR_BYTES)
				stderr += new TextDecoder()
					.decode(chunk)
					.slice(0, CHILD_STDERR_BYTES - stderr.length);
		});
		child.on("close", (code) =>
			finish(() => {
				const stdout = new Uint8Array(outBytes);
				let offset = 0;
				for (const chunk of outChunks) {
					stdout.set(chunk, offset);
					offset += chunk.byteLength;
				}
				resolve({ code, stdout, stderr, stdoutTruncated });
			}),
		);
		child.stdin.on("error", () => {
			// EPIPE when the child exits early; the close handler reports it.
		});
		child.stdin.end(input);
	});
}

function clampChars(
	text: string,
	limit: number,
): { text: string; cut: boolean } {
	if (text.length <= limit) return { text, cut: false };
	let end = limit;
	if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
	return { text: text.slice(0, end), cut: true };
}

async function extractPdf(
	bytes: Uint8Array,
	signal: AbortSignal,
): Promise<DocumentExtraction> {
	const result = await runDocumentProcess(
		PDFTOTEXT,
		[
			"-q",
			"-enc",
			"UTF-8",
			"-eol",
			"unix",
			"-nodiag",
			"-l",
			String(DOCUMENT_MAX_PAGES),
			"-",
			"-",
		],
		bytes,
		signal,
	);
	if (result.code !== 0 && !result.stdoutTruncated) {
		if (/password|encrypt/iu.test(result.stderr))
			throw new AttachmentError("unsupported-type", "PDF is encrypted");
		throw new AttachmentError(
			"unsupported-type",
			"PDF text could not be extracted",
		);
	}
	const raw = new TextDecoder("utf-8", { fatal: false }).decode(result.stdout);
	const pages = raw.split(PAGE_BREAK);
	if (pages.at(-1) === "") pages.pop();
	let text = "";
	let truncated = result.stdoutTruncated;
	let seen = 0;
	for (const [index, page] of pages.entries()) {
		seen++;
		const body = `${page.replace(/\n+$/u, "")}\n`;
		const chunk = index === 0 ? body : `\n[page ${index + 1}]\n${body}`;
		const room = DOCUMENT_MAX_CHARS - text.length;
		if (chunk.length > room) {
			text += clampChars(chunk, room).text;
			truncated = true;
			break;
		}
		text += chunk;
	}
	const empty = text.trim().length === 0;
	return {
		text: empty ? "" : text,
		truncated,
		pages: Math.max(seen, 1),
		note: empty
			? "PDF contains no extractable text (scanned or image-only pages; OCR is not performed)"
			: null,
	};
}

async function extractOffice(
	bytes: Uint8Array,
	format: "docx" | "xlsx",
	signal: AbortSignal,
): Promise<DocumentExtraction> {
	const result = await runDocumentProcess(
		PYTHON,
		[
			"-I",
			"-S",
			OFFICE_SCRIPT,
			format,
			String(DOCUMENT_MAX_CHARS),
			String(DOCUMENT_MAX_PAGES),
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
		pages?: unknown;
		note?: unknown;
	};
	if (typeof object.error === "string")
		throw new AttachmentError("unsupported-type", object.error.slice(0, 200));
	if (
		typeof object.text !== "string" ||
		typeof object.truncated !== "boolean" ||
		typeof object.pages !== "number" ||
		(object.note !== null && typeof object.note !== "string")
	)
		throw new AttachmentError(
			"unsupported-type",
			"Document extractor produced invalid output",
		);
	const clamped = clampChars(object.text, DOCUMENT_MAX_CHARS);
	return {
		text: clamped.text,
		truncated: object.truncated || clamped.cut,
		pages: object.pages,
		note: object.note,
	};
}

export async function extractDocument(
	bytes: Uint8Array,
	mime: string,
	signal: AbortSignal,
): Promise<DocumentExtraction> {
	if (!isDocumentMime(mime))
		throw new AttachmentError(
			"unsupported-type",
			"Attachment is not a document",
		);
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES)
		throw new AttachmentError("size-limit", "Document exceeds the size bound");
	signal.throwIfAborted();
	inspectDocument(mime, bytes);
	if (mime === "application/pdf") return extractPdf(bytes, signal);
	return extractOffice(
		bytes,
		mime ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			? "docx"
			: "xlsx",
		signal,
	);
}

/** Same paging contract as AttachmentStore.read, applied to extracted text. */
export function pageDocumentText(text: string, offset = 0): DocumentPage {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length)
		throw new AttachmentError(
			"invalid-id",
			"Attachment text offset is invalid",
		);
	let start = offset;
	if (
		start > 0 &&
		start < text.length &&
		isLowSurrogate(text.charCodeAt(start)) &&
		isHighSurrogate(text.charCodeAt(start - 1))
	)
		start--;
	let end = Math.min(start + ATTACHMENT_READ_CHARS, text.length);
	if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
	return {
		offset: start,
		text: text.slice(start, end),
		nextOffset: end < text.length ? end : null,
	};
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff;
}
