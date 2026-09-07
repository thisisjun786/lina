import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
} from "node:fs";
import { join } from "node:path";
import { CheckpointError } from "./errors.ts";
import { classifyExclusion, posixRel, resolveDirectory } from "./paths.ts";
import type { ManifestExclusion } from "./types.ts";

export type Fingerprint = {
	rel: string;
	ino: number;
	size: number;
	mtimeMs: number;
	nlink: number;
};

export type CapturedBytes = {
	rel: string;
	bytes: Buffer;
	size: number;
	mtime: string;
};

export type ComponentInventory = {
	files: CapturedBytes[];
	exclusions: ManifestExclusion[];
};

type ScanItem = {
	absolute: string;
	rel: string;
	fingerprint: Fingerprint;
};

const MAX_FILES = 100_000;

export function inventoryComponent(
	name: string,
	root: string,
): ComponentInventory {
	const absoluteRoot = resolveDirectory(root, false);
	const first = scanTree(name, absoluteRoot);
	const files = first.captures.map((item) => readStable(item));
	const second = scanTree(name, absoluteRoot);
	if (
		!sameScan(first.captures, second.captures) ||
		!sameExclusions(first.exclusions, second.exclusions)
	)
		throw new CheckpointError(
			"source-changed",
			`source changed during capture: ${absoluteRoot}`,
		);
	return { files, exclusions: first.exclusions };
}

function scanTree(
	component: string,
	root: string,
): { captures: ScanItem[]; exclusions: ManifestExclusion[] } {
	const captures: ScanItem[] = [];
	const exclusions: ManifestExclusion[] = [];
	walk(component, root, root, captures, exclusions);
	captures.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	exclusions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { captures, exclusions };
}

function walk(
	component: string,
	root: string,
	current: string,
	captures: ScanItem[],
	exclusions: ManifestExclusion[],
): void {
	const stat: Stats = lstatSync(current);
	assertSafeNode(current, stat);
	if (stat.isDirectory()) {
		const entries = readdirSync(current, { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			walk(component, root, join(current, entry.name), captures, exclusions);
		}
		return;
	}
	const rel = posixRel(root, current);
	const reason = classifyExclusion(rel);
	if (reason) {
		exclusions.push({ component, path: rel, reason });
		return;
	}
	if (captures.length >= MAX_FILES)
		throw new CheckpointError("invalid-input", "checkpoint exceeds file limit");
	captures.push({
		absolute: current,
		rel,
		fingerprint: fingerprint(rel, stat),
	});
}

function assertSafeNode(path: string, stat: Stats): void {
	if (stat.isSymbolicLink())
		throw new CheckpointError("unsafe-path", `unsafe symlink: ${path}`);
	if (stat.isFile()) {
		if (stat.nlink !== 1)
			throw new CheckpointError("unsafe-path", `unsafe hardlink: ${path}`);
		return;
	}
	if (stat.isDirectory()) return;
	throw new CheckpointError("unsafe-path", `unsafe special file: ${path}`);
}

function fingerprint(rel: string, stat: Stats): Fingerprint {
	return {
		rel,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		nlink: stat.nlink,
	};
}

function readStable(item: ScanItem): CapturedBytes {
	const fd = openSync(item.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before: Stats = fstatSync(fd);
		if (!before.isFile() || before.nlink !== 1)
			throw new CheckpointError(
				"unsafe-path",
				`unsafe regular file: ${item.absolute}`,
			);
		const bytes = Buffer.alloc(before.size);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(fd, bytes, used, bytes.length - used, used);
			if (!count) break;
			used += count;
		}
		const after: Stats = fstatSync(fd);
		if (
			used !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ino !== before.ino ||
			after.nlink !== 1
		)
			throw new CheckpointError(
				"source-changed",
				`source changed during capture: ${item.absolute}`,
			);
		return {
			rel: item.rel,
			bytes,
			size: before.size,
			mtime: new Date(before.mtimeMs).toISOString(),
		};
	} finally {
		closeSync(fd);
	}
}

function sameScan(left: ScanItem[], right: ScanItem[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const a = left[i];
		const b = right[i];
		if (
			!a ||
			!b ||
			a.rel !== b.rel ||
			a.fingerprint.ino !== b.fingerprint.ino ||
			a.fingerprint.size !== b.fingerprint.size ||
			a.fingerprint.mtimeMs !== b.fingerprint.mtimeMs ||
			a.fingerprint.nlink !== b.fingerprint.nlink
		)
			return false;
	}
	return true;
}

function sameExclusions(
	left: ManifestExclusion[],
	right: ManifestExclusion[],
): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const a = left[i];
		const b = right[i];
		if (!a || !b || a.path !== b.path || a.reason !== b.reason) return false;
	}
	return true;
}
