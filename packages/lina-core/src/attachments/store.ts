import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../protocol.ts";
import { validateBinding } from "../session-binding.ts";
import {
	atomicJson,
	checkedDirectory,
	checkedRegular,
	fsyncDirectory,
	readRegular,
	removeTemporary,
	writeExclusive,
} from "./filesystem.ts";
import {
	AttachmentError,
	type AttachmentManifest,
	type AttachmentMetadata,
	type AttachmentRead,
} from "./types.ts";
import {
	ATTACHMENT_ID,
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_FILES,
	ATTACHMENT_MAX_TOTAL_BYTES,
	ATTACHMENT_READ_CHARS,
	hash,
	inspectContent,
	manifestShape,
	metadataShape,
	validateId,
	validateName,
} from "./validation.ts";

export type { AttachmentMetadata, AttachmentRead } from "./types.ts";
export { AttachmentError } from "./types.ts";
export {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_FILES,
	ATTACHMENT_MAX_TOTAL_BYTES,
	ATTACHMENT_READ_CHARS,
} from "./validation.ts";

export class AttachmentStore {
	readonly binding: BotBinding;
	private readonly directory: string;
	private readonly filesDirectory: string;
	private readonly manifestPath: string;
	private records = new Map<string, AttachmentMetadata>();
	private totalBytes = 0;
	private orphanCount = 0;
	private closed = false;
	private poisoned = false;

	constructor(root: string, binding: BotBinding) {
		this.binding = validateBinding(binding);
		const parent = checkedDirectory(resolve(root), true);
		this.directory = checkedDirectory(join(parent, "attachments"), true);
		this.filesDirectory = checkedDirectory(join(this.directory, "files"), true);
		this.manifestPath = join(this.directory, "manifest.json");
		this.load();
	}

	isBoundTo(binding: BotBinding): boolean {
		return isDeepStrictEqual(this.binding, binding);
	}

	/** Check space for one new file; this does not reserve capacity or import bytes. */
	preflight(size: number): void {
		this.assertOpen();
		if (!Number.isSafeInteger(size) || size < 0 || size > ATTACHMENT_MAX_BYTES)
			throw new AttachmentError("size-limit", "Invalid attachment size");
		if (this.records.size + this.orphanCount >= ATTACHMENT_MAX_FILES)
			throw new AttachmentError("quota", "Attachment file quota is exhausted");
		if (this.totalBytes + size > ATTACHMENT_MAX_TOTAL_BYTES)
			throw new AttachmentError(
				"quota",
				"Attachment storage quota is exhausted",
			);
	}

	/** A caller-owned stable ID makes a generated artifact import replayable. */
	put(
		name: string,
		bytes: Uint8Array,
		id: string = randomUUID(),
	): AttachmentMetadata {
		this.assertOpen();
		validateId(id);
		const safeName = validateName(name);
		const mime = inspectContent(safeName, bytes);
		const previous = this.records.get(id);
		if (previous) {
			if (previous.name !== safeName || previous.sha256 !== hash(bytes))
				throw new AttachmentError("invalid-request", "Attachment ID conflict");
			return this.get(id);
		}
		const target = join(this.filesDirectory, id);
		const retained = lstatSync(target, { throwIfNoEntry: false });
		if (retained) {
			checkedRegular(target);
			if (hash(readRegular(target)) !== hash(bytes))
				throw new AttachmentError("invalid-request", "Attachment ID conflict");
		}
		if (
			!retained &&
			this.records.size + this.orphanCount >= ATTACHMENT_MAX_FILES
		)
			throw new AttachmentError("quota", "Attachment file quota is exhausted");
		if (
			!retained &&
			this.totalBytes + bytes.byteLength > ATTACHMENT_MAX_TOTAL_BYTES
		)
			throw new AttachmentError(
				"quota",
				"Attachment storage quota is exhausted",
			);
		const metadata: AttachmentMetadata = {
			id,
			name: safeName,
			mime,
			size: bytes.byteLength,
			sha256: hash(bytes),
		};
		const temporary = join(this.filesDirectory, `.upload-${randomUUID()}.tmp`);
		try {
			if (!retained) {
				writeExclusive(temporary, bytes);
				renameSync(temporary, target);
				fsyncDirectory(this.filesDirectory);
			}
			const next = [...this.records.values(), metadata];
			this.writeManifest(next);
			this.records.set(id, metadata);
			if (retained) this.orphanCount--;
			else this.totalBytes += metadata.size;
			return { ...metadata };
		} catch (error) {
			this.poisoned = true;
			throw error;
		} finally {
			removeTemporary(temporary);
		}
	}

	get(id: string): AttachmentMetadata {
		this.assertOpen();
		validateId(id);
		const metadata = this.records.get(id);
		if (!metadata)
			throw new AttachmentError("not-found", "Attachment not found");
		const path = join(this.filesDirectory, id);
		checkedRegular(path);
		this.verifyBytes(metadata, readRegular(path));
		return { ...metadata };
	}

	bytes(id: string): Uint8Array {
		this.assertOpen();
		validateId(id);
		const metadata = this.records.get(id);
		if (!metadata)
			throw new AttachmentError("not-found", "Attachment not found");
		const path = join(this.filesDirectory, id);
		checkedRegular(path);
		const bytes = readRegular(path);
		this.verifyBytes(metadata, bytes);
		return bytes;
	}

	read(id: string, offset = 0): AttachmentRead {
		const metadata = this.get(id);
		if (metadata.mime !== "text/plain")
			throw new AttachmentError(
				"unsupported-type",
				"Only UTF-8 text can be read",
			);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			this.bytes(id),
		);
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
		const page = text.slice(start, end);
		return {
			...metadata,
			offset: start,
			text: page,
			nextOffset: end < text.length ? end : null,
		};
	}

	close(): void {
		this.closed = true;
	}

	private load(): void {
		const names = readdirSync(this.filesDirectory);
		const manifestStat = lstatSync(this.manifestPath, {
			throwIfNoEntry: false,
		});
		if (!manifestStat) {
			if (names.length)
				throw new AttachmentError(
					"corrupt",
					"Orphaned attachment files have no manifest",
				);
			this.writeManifest([]);
			return;
		}
		checkedRegular(this.manifestPath);
		let manifest: AttachmentManifest;
		try {
			manifest = manifestShape(
				JSON.parse(new TextDecoder().decode(readRegular(this.manifestPath))),
			);
		} catch (error) {
			if (error instanceof AttachmentError) throw error;
			throw new AttachmentError(
				"corrupt",
				"Attachment manifest cannot be read",
			);
		}
		if (!isDeepStrictEqual(manifest.binding, this.binding))
			throw new AttachmentError(
				"foreign-binding",
				"Foreign attachment binding",
			);
		if (
			manifest.files.length > ATTACHMENT_MAX_FILES ||
			manifest.totalBytes > ATTACHMENT_MAX_TOTAL_BYTES
		)
			throw new AttachmentError("corrupt", "Attachment manifest exceeds quota");
		for (const item of manifest.files) {
			const metadata = metadataShape(item);
			if (this.records.has(metadata.id))
				throw new AttachmentError(
					"corrupt",
					"Attachment manifest has invalid records",
				);
			if (metadata.size < 0 || metadata.size > 2 * 1024 * 1024)
				throw new AttachmentError("corrupt", "Attachment metadata is invalid");
			const path = join(this.filesDirectory, metadata.id);
			checkedRegular(path);
			const bytes = readRegular(path);
			this.verifyBytes(metadata, bytes);
			this.records.set(metadata.id, { ...metadata });
			this.totalBytes += metadata.size;
		}
		if (this.totalBytes !== manifest.totalBytes)
			throw new AttachmentError(
				"corrupt",
				"Attachment manifest does not match its files",
			);
		for (const name of names) {
			if (this.records.has(name)) continue;
			if (
				!ATTACHMENT_ID.test(name) &&
				!/^\.upload-[0-9a-f-]{36}\.tmp$/.test(name)
			)
				throw new AttachmentError("corrupt", "Unknown attachment file");
			const path = join(this.filesDirectory, name);
			checkedRegular(path);
			const size = lstatSync(path).size;
			if (size > 2_097_152)
				throw new AttachmentError(
					"corrupt",
					"Orphaned attachment exceeds file bound",
				);
			// A committed owner manifest exists. Retain interrupted writes, never expose them.
			this.orphanCount++;
			this.totalBytes += size;
		}
		if (
			this.records.size + this.orphanCount > ATTACHMENT_MAX_FILES ||
			this.totalBytes > ATTACHMENT_MAX_TOTAL_BYTES
		)
			throw new AttachmentError(
				"quota",
				"Retained attachment files exceed quota",
			);
	}

	private writeManifest(files: AttachmentMetadata[]): void {
		const manifest: AttachmentManifest = {
			version: 1,
			binding: this.binding,
			files,
			totalBytes: files.reduce((sum, file) => sum + file.size, 0),
		};
		atomicJson(this.manifestPath, manifest);
	}

	private verifyBytes(metadata: AttachmentMetadata, bytes: Uint8Array): void {
		let mime: string;
		try {
			mime = inspectContent(metadata.name, bytes);
		} catch {
			throw new AttachmentError("corrupt", "Attachment integrity check failed");
		}
		if (
			bytes.byteLength !== metadata.size ||
			hash(bytes) !== metadata.sha256 ||
			mime !== metadata.mime
		)
			throw new AttachmentError("corrupt", "Attachment integrity check failed");
	}

	private assertOpen(): void {
		checkedDirectory(this.directory, false);
		checkedDirectory(this.filesDirectory, false);
		if (this.closed)
			throw new AttachmentError("closed", "Attachment store is closed");
		if (this.poisoned)
			throw new AttachmentError(
				"corrupt",
				"Attachment store has an unresolved write",
			);
	}
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff;
}
