import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CheckpointError } from "./errors.ts";
import { assertSafeAncestors, atomicWrite, resolveDirectory } from "./paths.ts";

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function newCheckpointId(): string {
	return `chk_${randomBytes(16).toString("hex")}`;
}

export function objectPath(historyRoot: string, hash: string): string {
	if (!/^[0-9a-f]{64}$/.test(hash))
		throw new CheckpointError("corrupt", "checkpoint object is corrupt");
	return join(historyRoot, "objects", hash.slice(0, 2), hash.slice(2));
}

export function putObject(historyRoot: string, bytes: Uint8Array): string {
	const hash = sha256(bytes);
	const dest = objectPath(historyRoot, hash);
	resolveDirectory(dirname(dest), true);
	const existing = lstatSync(dest, { throwIfNoEntry: false });
	if (existing) {
		if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
			throw new CheckpointError("unsafe-path", `unsafe object: ${dest}`);
		const previous = readFileSync(dest);
		if (sha256(previous) !== hash)
			throw new CheckpointError("corrupt", "checkpoint object is corrupt");
		return hash;
	}
	atomicWrite(dest, bytes);
	return hash;
}

export function readObject(
	historyRoot: string,
	hash: string,
	size: number,
): Buffer {
	const dest = objectPath(historyRoot, hash);
	assertSafeAncestors(dest);
	const stat = lstatSync(dest, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new CheckpointError("corrupt", "checkpoint object is corrupt");
	const bytes = readFileSync(dest);
	if (bytes.length !== size || sha256(bytes) !== hash)
		throw new CheckpointError("corrupt", "checkpoint object is corrupt");
	return bytes;
}
