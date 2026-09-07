import { createHash } from "node:crypto";
import { inspectDocument } from "./document-container.ts";
import {
	ATTACHMENT_MIMES,
	AttachmentError,
	type AttachmentManifest,
	type AttachmentMetadata,
	type AttachmentMime,
} from "./types.ts";

export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 256;
export const ATTACHMENT_READ_CHARS = 8192;
export const ATTACHMENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "log"]);

export function manifestShape(value: unknown): AttachmentManifest {
	if (typeof value !== "object" || value === null)
		throw new AttachmentError("corrupt", "Attachment manifest is invalid");
	const object = value as {
		version?: unknown;
		files?: unknown;
		totalBytes?: unknown;
		binding?: unknown;
	};
	if (
		Object.keys(value).sort().join(",") !==
			"binding,files,totalBytes,version" ||
		object.version !== 1 ||
		!Array.isArray(object.files) ||
		typeof object.totalBytes !== "number" ||
		!Number.isSafeInteger(object.totalBytes) ||
		object.totalBytes < 0 ||
		!object.binding
	)
		throw new AttachmentError("corrupt", "Attachment manifest is invalid");
	return value as AttachmentManifest;
}

export function metadataShape(value: unknown): AttachmentMetadata {
	if (typeof value !== "object" || value === null)
		throw new AttachmentError("corrupt", "Attachment metadata is invalid");
	const object = value as {
		id?: unknown;
		name?: unknown;
		mime?: unknown;
		size?: unknown;
		sha256?: unknown;
	};
	if (
		Object.keys(value).sort().join(",") !== "id,mime,name,sha256,size" ||
		typeof object.id !== "string" ||
		typeof object.name !== "string" ||
		typeof object.mime !== "string" ||
		typeof object.size !== "number" ||
		typeof object.sha256 !== "string" ||
		!Number.isSafeInteger(object.size) ||
		!ATTACHMENT_ID.test(object.id) ||
		!/^[0-9a-f]{64}$/u.test(object.sha256)
	)
		throw new AttachmentError("corrupt", "Attachment metadata is invalid");
	try {
		validateName(object.name);
	} catch {
		throw new AttachmentError("corrupt", "Attachment metadata is invalid");
	}
	if (!(ATTACHMENT_MIMES as readonly string[]).includes(object.mime))
		throw new AttachmentError("corrupt", "Attachment metadata is invalid");
	return value as AttachmentMetadata;
}

export function validateId(id: string): void {
	if (!ATTACHMENT_ID.test(id))
		throw new AttachmentError("invalid-id", "Invalid attachment id");
}

export function validateName(name: string): string {
	if (
		name.length < 1 ||
		name.length > 120 ||
		name === "." ||
		name === ".." ||
		/[\\/]/u.test(name) ||
		[...name].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || code === 0x7f;
		}) ||
		/[[\]<>&"']/u.test(name)
	)
		throw new AttachmentError("invalid-name", "Attachment name is unsafe");
	return name;
}

function expectedMime(name: string): AttachmentMime {
	const extension = name.split(".").pop()?.toLowerCase() ?? "";
	if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
	if (extension === "png") return "image/png";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "pdf") return "application/pdf";
	if (extension === "docx")
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (extension === "xlsx")
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	throw new AttachmentError("unsupported-type", "Unsupported attachment type");
}

function dimensionsWithinLimit(width: number, height: number): void {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width * height > 16_000_000
	)
		throw new AttachmentError(
			"unsupported-type",
			"Image dimensions are unsafe",
		);
}

function validatePng(bytes: Uint8Array): void {
	if (
		bytes.length < 45 ||
		!bytes
			.slice(0, 8)
			.every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
	)
		throw new AttachmentError(
			"unsupported-type",
			"Content does not match its extension",
		);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
		throw new AttachmentError("unsupported-type", "PNG header is invalid");
	dimensionsWithinLimit(view.getUint32(16), view.getUint32(20));
	let offset = 8,
		data = false,
		ended = false;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset),
			type = view.getUint32(offset + 4),
			end = offset + 12 + length;
		if (end > bytes.length)
			throw new AttachmentError("unsupported-type", "PNG chunk is incomplete");
		let crc = 0xffffffff;
		for (let i = offset + 4; i < end - 4; i++) {
			crc ^= bytes[i] ?? 0;
			for (let bit = 0; bit < 8; bit++)
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(end - 4))
			throw new AttachmentError("unsupported-type", "PNG checksum is invalid");
		if (type === 0x49444154) data = true;
		if (type === 0x49454e44) {
			ended = length === 0 && end === bytes.length;
			break;
		}
		offset = end;
	}
	if (!data || !ended)
		throw new AttachmentError(
			"unsupported-type",
			"PNG container is incomplete",
		);
}

function validateJpeg(bytes: Uint8Array): void {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
		throw new AttachmentError(
			"unsupported-type",
			"Content does not match its extension",
		);
	let offset = 2;
	while (offset < bytes.length) {
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++];
		if (marker === undefined) break;
		if (marker === 0xd9) break;
		if (
			marker === 0xd8 ||
			(marker >= 0xd0 && marker <= 0xd7) ||
			marker === 0x01
		)
			continue;
		if (offset + 1 >= bytes.length) break;
		const length = ((bytes[offset] ?? -1) << 8) | (bytes[offset + 1] ?? -1);
		if (length < 2 || offset + length > bytes.length)
			throw new AttachmentError("unsupported-type", "JPEG segment is invalid");
		if (
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf)
		) {
			if (length < 7)
				throw new AttachmentError(
					"unsupported-type",
					"JPEG dimensions are invalid",
				);
			const view = new DataView(
				bytes.buffer,
				bytes.byteOffset + offset,
				length,
			);
			dimensionsWithinLimit(view.getUint16(3), view.getUint16(5));
			return;
		}
		offset += length;
	}
	throw new AttachmentError("unsupported-type", "JPEG dimensions are missing");
}

export function inspectContent(
	name: string,
	bytes: Uint8Array,
): AttachmentMime {
	validateName(name);
	if (bytes.length > ATTACHMENT_MAX_BYTES)
		throw new AttachmentError(
			"size-limit",
			"Attachment exceeds the 2 MiB size limit",
		);
	const mime = expectedMime(name);
	if (mime === "text/plain") {
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (text.includes("\u0000")) throw new Error("NUL");
		} catch {
			throw new AttachmentError("unsupported-type", "Text is not valid UTF-8");
		}
	} else if (mime === "image/png") validatePng(bytes);
	else if (mime === "image/jpeg") validateJpeg(bytes);
	else inspectDocument(mime, bytes);
	return mime;
}

export function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sameMetadata(
	a: AttachmentMetadata,
	b: AttachmentMetadata,
): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.mime === b.mime &&
		a.size === b.size &&
		a.sha256 === b.sha256
	);
}
