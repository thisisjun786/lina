import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "./manifest.ts";
import { readObject } from "./objects.ts";
import { assertCheckpointId, resolveExistingHistory } from "./paths.ts";
import type {
	CheckpointDiff,
	CheckpointManifest,
	CheckpointSummary,
} from "./types.ts";

export function listCheckpoints(historyRoot: string): CheckpointSummary[] {
	const root = resolveExistingHistory(historyRoot);
	const dir = join(root, "checkpoints");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	const summaries: CheckpointSummary[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		assertCheckpointId(name);
		const manifest = readManifest(root, name);
		summaries.push({
			id: manifest.id,
			createdAt: manifest.createdAt,
			reason: manifest.reason,
			complete: manifest.complete,
			coverageGaps: manifest.coverageGaps,
		});
	}
	summaries.sort((a, b) =>
		a.createdAt < b.createdAt
			? -1
			: a.createdAt > b.createdAt
				? 1
				: a.id < b.id
					? -1
					: 1,
	);
	return summaries;
}

export function verifyCheckpoint(
	historyRoot: string,
	id: string,
): CheckpointManifest {
	assertCheckpointId(id);
	const root = resolveExistingHistory(historyRoot);
	const manifest = readManifest(root, id);
	for (const file of manifest.files) readObject(root, file.hash, file.size);
	return manifest;
}

export function diffCheckpoints(
	historyRoot: string,
	left: string,
	right: string,
): CheckpointDiff {
	const leftManifest = verifyCheckpoint(historyRoot, left);
	const rightManifest = verifyCheckpoint(historyRoot, right);
	const leftMap = new Map(
		leftManifest.files.map((file) => [`${file.component}/${file.path}`, file]),
	);
	const rightMap = new Map(
		rightManifest.files.map((file) => [`${file.component}/${file.path}`, file]),
	);
	const added: CheckpointDiff["added"] = [];
	const removed: CheckpointDiff["removed"] = [];
	const changed: CheckpointDiff["changed"] = [];
	for (const [key, file] of leftMap) {
		const other = rightMap.get(key);
		if (!other) {
			removed.push({ component: file.component, path: file.path });
			continue;
		}
		if (other.hash !== file.hash)
			changed.push({
				component: file.component,
				path: file.path,
				leftHash: file.hash,
				rightHash: other.hash,
			});
	}
	for (const [key, file] of rightMap) {
		if (!leftMap.has(key))
			added.push({ component: file.component, path: file.path });
	}
	const byPath = (a: { component: string; path: string }, b: typeof a) =>
		a.component !== b.component
			? a.component < b.component
				? -1
				: 1
			: a.path < b.path
				? -1
				: a.path > b.path
					? 1
					: 0;
	added.sort(byPath);
	removed.sort(byPath);
	changed.sort(byPath);
	return {
		left: leftManifest.id,
		right: rightManifest.id,
		added,
		removed,
		changed,
	};
}
