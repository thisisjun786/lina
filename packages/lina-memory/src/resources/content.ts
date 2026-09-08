import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	checkedDirectory,
	fsyncDirectory,
	readRegular,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTION = 2 * 1024 * 1024;
const MAX_BLOBS = 4096;
const HASH = /^[a-f0-9]{64}$/;
const STAGE = /^\.stage-[a-f0-9-]{36}$/;
export interface ResourceContentLimits {
	maxFileBytes: number;
	maxCatalogBytes: number;
	maxExtractionBytes: number;
}
export interface ResourceBlob {
	hash: string;
	byteLength: number;
}
function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
/** Internal blob primitive. Catalog owner holds BEGIN IMMEDIATE across put and its DB commit. */
export class ResourceContent {
	private readonly root: string;
	private readonly limits: ResourceContentLimits;
	constructor(root: string, limits: ResourceContentLimits) {
		if (
			!limits ||
			typeof limits !== "object" ||
			Object.keys(limits).length !== 3
		)
			throw Error("invalid resource content limit");
		for (const value of [
			limits.maxFileBytes,
			limits.maxCatalogBytes,
			limits.maxExtractionBytes,
		]) {
			if (!Number.isSafeInteger(value) || value < 1)
				throw Error("invalid resource content limit");
		}
		if (
			limits.maxFileBytes > limits.maxCatalogBytes ||
			limits.maxCatalogBytes > MAX_BYTES ||
			limits.maxExtractionBytes > MAX_EXTRACTION
		)
			throw Error("invalid resource content limit");
		this.limits = { ...limits };
		this.root = checkedDirectory(root, true);
		this.usage();
	}
	usage(): { bytes: number; blobs: number } {
		const names = readdirSync(this.root);
		if (names.length > MAX_BLOBS)
			throw Error("resource blob count limit exceeded");
		let bytes = 0;
		for (const name of names) {
			if (!HASH.test(name) && !STAGE.test(name))
				throw Error("corrupt resource blob name");
			const data = readRegular(join(this.root, name), this.limits.maxFileBytes);
			if (HASH.test(name) && digest(data) !== name)
				throw Error("corrupt resource blob hash");
			bytes += data.length;
			if (bytes > this.limits.maxCatalogBytes)
				throw Error("resource catalog limit exceeded");
		}
		// Interrupted staging bytes also count; opening the store never deletes them.
		return { bytes, blobs: names.length };
	}
	read(blob: ResourceBlob): Uint8Array {
		if (
			!HASH.test(blob.hash) ||
			!Number.isSafeInteger(blob.byteLength) ||
			blob.byteLength < 0 ||
			blob.byteLength > this.limits.maxFileBytes
		)
			throw Error("corrupt resource blob reference");
		const bytes = readRegular(
			join(this.root, blob.hash),
			this.limits.maxFileBytes,
		);
		if (bytes.length !== blob.byteLength || digest(bytes) !== blob.hash)
			throw Error("corrupt resource blob");
		return bytes;
	}
	put(input: Uint8Array): ResourceBlob {
		if (
			!(input instanceof Uint8Array) ||
			input.length > this.limits.maxFileBytes
		)
			throw Error("resource file limit exceeded");
		const bytes = Uint8Array.from(input);
		const blob = { hash: digest(bytes), byteLength: bytes.length };
		const finalPath = join(this.root, blob.hash);
		if (existsSync(finalPath)) {
			this.read(blob);
			fsyncDirectory(this.root);
			return blob;
		}
		const usage = this.usage();
		if (
			usage.bytes + bytes.length > this.limits.maxCatalogBytes ||
			usage.blobs >= MAX_BLOBS
		)
			throw Error("resource catalog limit exceeded");
		const stage = join(this.root, `.stage-${randomUUID()}`);
		try {
			writeExclusive(stage, bytes);
			const staged = readRegular(stage, this.limits.maxFileBytes);
			if (staged.length !== blob.byteLength || digest(staged) !== blob.hash)
				throw Error("corrupt resource staging");
			renameSync(stage, finalPath);
			fsyncDirectory(this.root);
			return blob;
		} catch (failure) {
			// Only this call's exclusive staging file, never an existing/user blob.
			try {
				unlinkSync(stage);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
				)
					throw new AggregateError(
						[failure, error],
						"resource write and staging cleanup failed",
					);
			}
			throw failure;
		}
	}
}
