import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { AttachmentError } from "./types.ts";

const NO_FOLLOW = constants.O_NOFOLLOW;
const NEW_FILE =
	constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW;

export function checkedDirectory(path: string, create: boolean): string {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute
		.slice(current.length)
		.split(sep)
		.filter(Boolean)) {
		current = join(current, part);
		let stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat && create) {
			try {
				mkdirSync(current, { mode: 0o700 });
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "EEXIST"
					)
				)
					throw error;
			}
			stat = lstatSync(current);
		}
		if (!stat?.isDirectory() || stat.isSymbolicLink())
			throw new AttachmentError(
				"unsafe-storage",
				`Unsafe attachment directory: ${current}`,
			);
	}
	return absolute;
}

export function checkedRegular(path: string, required = true): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) {
		if (required)
			throw new AttachmentError("corrupt", `Missing attachment file: ${path}`);
		return;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new AttachmentError(
			"unsafe-storage",
			`Unsafe attachment file: ${path}`,
		);
}

export function readRegular(path: string, maxBytes = 2_097_152): Uint8Array {
	checkedDirectory(dirname(path), false);
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1)
			throw new AttachmentError(
				"unsafe-storage",
				`Unsafe attachment file: ${path}`,
			);
		if (stat.size > maxBytes)
			throw new AttachmentError(
				"corrupt",
				"Attachment file exceeds its storage bound",
			);
		const bytes = new Uint8Array(stat.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(fd, bytes, used, bytes.length - used, null);
			if (!count) break;
			used += count;
		}
		if (used !== stat.size || fstatSync(fd).size !== stat.size)
			throw new AttachmentError("corrupt", "Attachment changed during read");
		return bytes.slice(0, used);
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError(
			"unsafe-storage",
			`Unsafe attachment file: ${path}`,
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function writeExclusive(path: string, bytes: Uint8Array): void {
	checkedDirectory(dirname(path), false);
	const fd = openSync(path, NEW_FILE, 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function fsyncDirectory(path: string): void {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
	);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function atomicJson(path: string, value: unknown): void {
	const directory = dirname(path);
	const temporary = join(directory, `.manifest-${randomUUID()}.tmp`);
	try {
		writeExclusive(
			temporary,
			new TextEncoder().encode(`${JSON.stringify(value)}\n`),
		);
		checkedRegular(path, false);
		renameSync(temporary, path);
		fsyncDirectory(directory);
	} finally {
		removeTemporary(temporary);
	}
}

export function removeTemporary(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
	}
}
