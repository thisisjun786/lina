import { extractDocument } from "../../lina-core/src/attachments/document.ts";
import {
	ATTACHMENT_MAX_BYTES,
	AttachmentError,
	type AttachmentStore,
} from "../../lina-core/src/attachments/store.ts";
import { isDocumentMime } from "../../lina-core/src/attachments/types.ts";
import type { BotBinding } from "../../lina-core/src/protocol.ts";

const PREFIX = "/api/attachments";
const BODY_DEADLINE_MS = 10_000;
const PREVIEW_MAX_CHARS = 16_384;

function previewText(extraction: {
	text: string;
	truncated: boolean;
	pages: number;
	note: string | null;
}): string {
	const parts: string[] = [];
	if (extraction.note) parts.push(`[${extraction.note}]`);
	let body = extraction.text;
	let truncated = extraction.truncated;
	const marker = "\n[preview truncated]";
	const headerLength = parts.length ? (parts[0]?.length ?? 0) : 0;
	const room = PREVIEW_MAX_CHARS - headerLength - marker.length - 1;
	if (body.length > room) {
		let end = room;
		const last = body.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
		body = body.slice(0, end);
		truncated = true;
	}
	if (body) parts.push(body);
	let text = parts.join("\n");
	if (truncated) text += marker;
	return text;
}

function headers(extra?: Record<string, string>): Headers {
	const result = new Headers(extra);
	result.set("Cache-Control", "no-store");
	result.set("X-Content-Type-Options", "nosniff");
	return result;
}

function errorResponse(error: AttachmentError): Response {
	return Response.json(
		{ code: error.code, message: error.message },
		{ status: error.status, headers: headers() },
	);
}

function requestSession(
	request: Request,
	binding: BotBinding,
	post: boolean,
): void {
	const session = post
		? request.headers.get("X-Lina-Session")
		: new URL(request.url).searchParams.get("sessionId");
	if (!session)
		throw new AttachmentError(
			"invalid-request",
			"Attachment session is required",
		);
	if (session !== binding.sessionId)
		throw new AttachmentError(
			"foreign-session",
			"Attachment session does not match",
		);
}

async function readBody(request: Request): Promise<Uint8Array> {
	const contentLength = request.headers.get("Content-Length");
	if (contentLength !== null) {
		if (!/^\d+$/u.test(contentLength))
			throw new AttachmentError(
				"size-limit",
				"Attachment body length is invalid",
			);
		if (Number(contentLength) > ATTACHMENT_MAX_BYTES)
			throw new AttachmentError(
				"size-limit",
				"Attachment exceeds the 2 MiB size limit",
			);
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(new AttachmentError("deadline", "Attachment upload timed out")),
			BODY_DEADLINE_MS,
		);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline]);
			if (result.done) break;
			total += result.value.byteLength;
			if (total > ATTACHMENT_MAX_BYTES)
				throw new AttachmentError(
					"size-limit",
					"Attachment exceeds the 2 MiB size limit",
				);
			chunks.push(result.value);
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		void reader.cancel().catch(() => {
			// Preserve the body or deadline error if cancellation races the reader.
		});
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function decodeFilename(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new AttachmentError(
			"invalid-name",
			"Attachment filename encoding is invalid",
		);
	}
}

export async function handleAttachmentRequest(
	request: Request,
	store: AttachmentStore,
	binding: BotBinding,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const isPost = url.pathname === PREFIX;
	const suffix = url.pathname.startsWith(`${PREFIX}/`)
		? url.pathname.slice(PREFIX.length + 1).split("/")
		: [];
	const isGet =
		request.method === "GET" &&
		(suffix.length === 1 ||
			(suffix.length === 2 && ["preview", "meta"].includes(suffix[1] ?? "")));
	if (!isPost && !isGet) {
		if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`))
			return errorResponse(
				new AttachmentError(
					"invalid-id",
					"Unsupported attachment method or path",
				),
			);
		return undefined;
	}
	try {
		if (!store.isBoundTo(binding))
			throw new AttachmentError(
				"foreign-binding",
				"Foreign attachment binding",
			);
		requestSession(request, binding, isPost);
		if (isPost) {
			const encodedName = request.headers.get("X-Lina-Filename");
			if (!encodedName)
				throw new AttachmentError(
					"invalid-name",
					"Attachment filename is required",
				);
			const receipt = store.put(
				decodeFilename(encodedName),
				await readBody(request),
			);
			return Response.json(receipt, { status: 201, headers: headers() });
		}
		const id = suffix[0] ?? "";
		const metadata = store.get(id);
		if (suffix[1] === "meta")
			return Response.json(metadata, { headers: headers() });
		const bytes = store.bytes(id);
		if (suffix[1] === "preview") {
			if (metadata.mime === "text/plain")
				return new Response(new TextDecoder().decode(bytes), {
					headers: headers({ "Content-Type": "text/plain; charset=utf-8" }),
				});
			if (isDocumentMime(metadata.mime)) {
				const extraction = await extractDocument(
					bytes,
					metadata.mime,
					request.signal,
				);
				return new Response(previewText(extraction), {
					headers: headers({
						"Content-Type": "text/plain; charset=utf-8",
						"Content-Disposition": "inline",
					}),
				});
			}
			return new Response(bytes, {
				headers: headers({ "Content-Type": metadata.mime }),
			});
		}
		return new Response(bytes, {
			headers: headers({
				"Content-Type": metadata.mime,
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
			}),
		});
	} catch (error) {
		if (error instanceof AttachmentError) return errorResponse(error);
		return errorResponse(
			new AttachmentError("corrupt", "Attachment request failed"),
		);
	}
}
