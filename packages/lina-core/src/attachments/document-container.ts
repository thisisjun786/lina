import { type AttachmentDocumentMime, AttachmentError } from "./types.ts";

/**
 * Ingress sniffing for document containers. This runs synchronously inside
 * AttachmentStore.put/verify, so it only walks headers and the zip central
 * directory; it never inflates entries. Text extraction happens later in a
 * bounded child process (document.ts).
 */

export const DOCUMENT_MAX_ENTRIES = 512;
export const DOCUMENT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const DOCUMENT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_COMMENT = 0xffff;

const EXECUTABLE_EXTENSIONS = new Set([
	"exe",
	"dll",
	"com",
	"bat",
	"cmd",
	"ps1",
	"vbs",
	"vbe",
	"js",
	"jse",
	"wsf",
	"wsh",
	"scr",
	"msi",
	"jar",
	"sh",
	"hta",
	"lnk",
	"pif",
	"cpl",
]);

export interface ZipEntrySummary {
	name: string;
	compressedSize: number;
	uncompressedSize: number;
}

function reject(message: string): never {
	throw new AttachmentError("unsupported-type", message);
}

function findEndRecord(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const floor = Math.max(0, bytes.length - 22 - MAX_COMMENT);
	for (let offset = bytes.length - 22; offset >= floor; offset--) {
		if (view.getUint32(offset, true) === ZIP_END) return offset;
	}
	return reject("Zip container has no end record");
}

/** Walk the central directory without inflating anything. */
export function listZipEntries(bytes: Uint8Array): ZipEntrySummary[] {
	if (bytes.length < 22) reject("Content does not match its extension");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== ZIP_LOCAL)
		reject("Content does not match its extension");
	const end = findEndRecord(bytes);
	const diskNumber = view.getUint16(end + 4, true);
	const count = view.getUint16(end + 10, true);
	const size = view.getUint32(end + 12, true);
	const start = view.getUint32(end + 16, true);
	if (diskNumber !== 0 || count !== view.getUint16(end + 8, true))
		reject("Zip container spans disks");
	if (count > DOCUMENT_MAX_ENTRIES)
		reject("Zip container has too many entries");
	if (start + size !== end || start > end)
		reject("Zip central directory is inconsistent");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const entries: ZipEntrySummary[] = [];
	const seen = new Set<string>();
	let offset = start;
	let total = 0;
	for (let index = 0; index < count; index++) {
		if (offset + 46 > end) reject("Zip central directory is truncated");
		if (view.getUint32(offset, true) !== ZIP_CENTRAL)
			reject("Zip central directory is invalid");
		const flags = view.getUint16(offset + 8, true);
		const method = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const uncompressedSize = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const nameEnd = offset + 46 + nameLength;
		if (nameEnd + extraLength + commentLength > end)
			reject("Zip central directory is truncated");
		let name: string;
		try {
			name = decoder.decode(bytes.subarray(offset + 46, nameEnd));
		} catch {
			return reject("Zip entry name is not UTF-8");
		}
		if (flags & 0x0001) reject("Zip entry is encrypted");
		if (method !== 0 && method !== 8)
			reject("Zip entry uses an unsupported compression method");
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localOffset === 0xffffffff
		)
			reject("Zip64 containers are not supported");
		if (localOffset >= start) reject("Zip entry offset is invalid");
		if (compressedSize > bytes.length)
			reject("Zip entry size exceeds the container");
		if (uncompressedSize > DOCUMENT_MAX_ENTRY_BYTES)
			reject("Zip entry uncompressed size exceeds the bound");
		validateEntryName(name);
		if (seen.has(name)) reject("Zip entry name is duplicated");
		seen.add(name);
		total += uncompressedSize;
		if (total > DOCUMENT_MAX_UNCOMPRESSED_BYTES)
			reject("Zip container uncompressed size exceeds the bound");
		entries.push({ name, compressedSize, uncompressedSize });
		offset = nameEnd + extraLength + commentLength;
	}
	if (offset !== end) reject("Zip central directory is inconsistent");
	return entries;
}

function validateEntryName(name: string): void {
	if (
		name.length === 0 ||
		name.length > 512 ||
		name.startsWith("/") ||
		name.includes("\\") ||
		name.includes("\u0000") ||
		/^[A-Za-z]:/u.test(name) ||
		name.split("/").some((part) => part === "..")
	)
		reject("Zip entry name is unsafe");
	const leaf = name.split("/").pop() ?? "";
	const extension = leaf.includes(".")
		? (leaf.split(".").pop()?.toLowerCase() ?? "")
		: "";
	if (EXECUTABLE_EXTENSIONS.has(extension))
		reject("Office container carries an executable asset");
	const lower = name.toLowerCase();
	if (
		lower.includes("vbaproject") ||
		(lower.endsWith(".bin") && lower.includes("macro")) ||
		lower.startsWith("word/vba") ||
		lower.startsWith("xl/vba") ||
		lower.startsWith("macros/")
	)
		reject("Office container carries macros");
	if (
		lower.includes("/externallinks/") ||
		lower.startsWith("externallinks/") ||
		lower.startsWith("xl/externallinks")
	)
		reject("Office container carries external links");
	if (
		lower.startsWith("word/embeddings/") ||
		lower.startsWith("xl/embeddings/")
	)
		reject("Office container carries embedded objects");
}

function inspectOffice(mime: AttachmentDocumentMime, bytes: Uint8Array): void {
	const entries = listZipEntries(bytes);
	const names = new Set(entries.map((entry) => entry.name));
	if (
		mime ===
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	) {
		if ([...names].some((name) => name.startsWith("xl/")))
			reject("Content does not match its extension");
		if (!names.has("word/document.xml"))
			reject("DOCX container has no document part");
	} else {
		if ([...names].some((name) => name.startsWith("word/")))
			reject("Content does not match its extension");
		if (!names.has("xl/workbook.xml"))
			reject("XLSX container has no workbook part");
	}
	if (!names.has("[Content_Types].xml"))
		reject("Office container has no content types part");
}

function inspectPdf(bytes: Uint8Array): void {
	if (bytes.length < 64) reject("Content does not match its extension");
	const head = latin1(bytes.subarray(0, 1024));
	if (!/^%PDF-1\.[0-9]/u.test(head))
		reject("Content does not match its extension");
	const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
	if (!tail.includes("%%EOF")) reject("PDF container is incomplete");
	if (/\/Encrypt\b/u.test(tail)) reject("PDF is encrypted");
}

function latin1(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) result += String.fromCharCode(byte);
	return result;
}

export function inspectDocument(
	mime: AttachmentDocumentMime,
	bytes: Uint8Array,
): void {
	if (mime === "application/pdf") inspectPdf(bytes);
	else inspectOffice(mime, bytes);
}
