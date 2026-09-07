import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CheckpointError } from "./errors.ts";
import { readObject } from "./objects.ts";
import {
	atomicWrite,
	DIR_MODE,
	joinPosix,
	resolveDirectory,
	resolveExistingHistory,
	writePrivateFile,
} from "./paths.ts";
import { verifyCheckpoint } from "./query.ts";
import {
	CALLER_BARRIER_WARNING,
	MANIFEST_VERSION,
	REVIEW_MARKER,
	type RestoreResult,
	type RestoreReview,
} from "./types.ts";

const REQUIRES = [
	"rebind workspace bindings and session headers",
	"revalidate permissions, host bindings and schedules",
	"do not replay completed jobs or revive old running jobs",
	"reauthenticate credentials; they were excluded from the checkpoint",
];

export function restoreCheckpoint(
	historyRoot: string,
	id: string,
	target: string,
): RestoreResult {
	const root = resolveExistingHistory(historyRoot);
	const manifest = verifyCheckpoint(root, id);
	const absoluteTarget = resolveDirectory(dirname(target), false);
	const destination = join(absoluteTarget, requireLeaf(target));
	const existing = lstatSync(destination, { throwIfNoEntry: false });
	if (existing)
		throw new CheckpointError(
			"target-exists",
			`restore target already exists: ${destination}`,
		);
	mkdirSync(destination, { mode: DIR_MODE });
	try {
		for (const file of manifest.files) {
			const bytes = readObject(root, file.hash, file.size);
			const path = joinPosix(destination, file.component, file.path);
			writePrivateFile(path, bytes);
		}
		const review: RestoreReview = {
			version: MANIFEST_VERSION,
			checkpointId: manifest.id,
			restoredAt: new Date().toISOString(),
			startable: false,
			reviewRequired: true,
			complete: manifest.complete,
			coverageGaps: manifest.coverageGaps,
			exclusions: manifest.exclusions,
			requires: REQUIRES,
			warnings: [CALLER_BARRIER_WARNING],
		};
		const reviewMarker = join(destination, REVIEW_MARKER);
		atomicWrite(
			reviewMarker,
			Buffer.from(`${JSON.stringify(review, null, "\t")}\n`),
		);
		return {
			target: destination,
			checkpointId: manifest.id,
			reviewMarker,
			complete: manifest.complete,
			coverageGaps: manifest.coverageGaps,
		};
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

function requireLeaf(target: string): string {
	const trimmed = target.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	const leaf = parts[parts.length - 1];
	if (!leaf || leaf === "." || leaf === "..")
		throw new CheckpointError("invalid-input", "invalid restore target");
	return leaf;
}
