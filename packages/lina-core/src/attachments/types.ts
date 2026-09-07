import type { BotBinding } from "../protocol.ts";

export type AttachmentImageMime = "image/png" | "image/jpeg";

export type AttachmentDocumentMime =
	| "application/pdf"
	| "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	| "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type AttachmentMime =
	| "text/plain"
	| AttachmentImageMime
	| AttachmentDocumentMime;

export const ATTACHMENT_MIMES: readonly AttachmentMime[] = [
	"text/plain",
	"image/png",
	"image/jpeg",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export function isDocumentMime(mime: string): mime is AttachmentDocumentMime {
	return (
		mime === "application/pdf" ||
		mime ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	);
}

export function isImageMime(mime: string): mime is AttachmentImageMime {
	return mime === "image/png" || mime === "image/jpeg";
}

/** Bounded text extracted from a document attachment. */
export interface DocumentExtraction {
	text: string;
	/** True when output stopped at the character bound; text is a prefix. */
	truncated: boolean;
	/** Pages (PDF), paragraphs (DOCX), or sheets (XLSX) seen by the extractor. */
	pages: number;
	/** Human-readable extractor remark, e.g. no extractable text. */
	note: string | null;
}

export interface AttachmentMetadata {
	id: string;
	name: string;
	mime: AttachmentMime;
	size: number;
	sha256: string;
}

export interface AttachmentRead extends AttachmentMetadata {
	offset: number;
	text: string;
	nextOffset: number | null;
}

export type AttachmentErrorCode =
	| "invalid-name"
	| "invalid-id"
	| "unsupported-type"
	| "size-limit"
	| "quota"
	| "not-found"
	| "foreign-binding"
	| "foreign-session"
	| "invalid-request"
	| "corrupt"
	| "unsafe-storage"
	| "deadline"
	| "closed";

const STATUS: Record<AttachmentErrorCode, number> = {
	"invalid-name": 400,
	"invalid-id": 400,
	"unsupported-type": 415,
	"size-limit": 413,
	quota: 507,
	"not-found": 404,
	"foreign-binding": 403,
	"foreign-session": 403,
	"invalid-request": 400,
	corrupt: 500,
	"unsafe-storage": 500,
	deadline: 408,
	closed: 500,
};

export class AttachmentError extends Error {
	readonly status: number;

	constructor(
		readonly code: AttachmentErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AttachmentError";
		this.status = STATUS[code];
	}
}

export interface AttachmentManifest {
	version: 1;
	binding: BotBinding;
	files: AttachmentMetadata[];
	totalBytes: number;
}
