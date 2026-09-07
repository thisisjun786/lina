import { CheckpointError } from "./errors.ts";
import { exportManifestToGit } from "./git-export.ts";
import { inventoryComponent } from "./inventory.ts";
import { writeManifest } from "./manifest.ts";
import { newCheckpointId, putObject } from "./objects.ts";
import {
	assertComponentName,
	assertDisjointHistory,
	assertReason,
	normalizeGaps,
	resolveDirectory,
	withHistoryLock,
} from "./paths.ts";
import {
	CALLER_BARRIER_WARNING,
	type CheckpointComponent,
	type CheckpointManifest,
	type CreateCheckpointInput,
	MANIFEST_VERSION,
	type ManifestExclusion,
	type ManifestFile,
} from "./types.ts";

const CREDENTIAL_GAP = "credentials were excluded and must be reauthenticated";

export function createCheckpoint(
	input: CreateCheckpointInput,
): CheckpointManifest {
	const reason = assertReason(input.reason);
	const coverageGaps = normalizeGaps(input.coverageGaps);
	if (!Array.isArray(input.components) || input.components.length === 0)
		throw new CheckpointError("invalid-input", "components are required");
	for (const component of input.components) {
		assertComponentName(component.name);
		assertDisjointHistory(input.historyRoot, component.root);
	}
	const historyRoot = resolveDirectory(input.historyRoot, true);
	return withHistoryLock(historyRoot, () =>
		createLocked(
			historyRoot,
			input.components,
			reason,
			coverageGaps,
			input.exportGit === true,
		),
	);
}

function createLocked(
	historyRoot: string,
	components: CheckpointComponent[],
	reason: string,
	coverageGaps: string[],
	exportGit: boolean,
): CheckpointManifest {
	const names = new Set<string>();
	const files: ManifestFile[] = [];
	const exclusions: ManifestExclusion[] = [];
	const gaps = [...coverageGaps];
	for (const component of components) {
		const name = assertComponentName(component.name);
		if (names.has(name))
			throw new CheckpointError(
				"duplicate-component",
				`duplicate component name: ${name}`,
			);
		names.add(name);
		const root = resolveDirectory(component.root, false);
		assertDisjointHistory(historyRoot, root);
		const inventory = inventoryComponent(name, root);
		for (const item of inventory.files) {
			const hash = putObject(historyRoot, item.bytes);
			files.push({
				component: name,
				path: item.rel,
				hash,
				size: item.size,
				mtime: item.mtime,
			});
		}
		exclusions.push(...inventory.exclusions);
		addWalGaps(
			name,
			inventory.files.map((item) => item.rel),
			gaps,
		);
	}
	files.sort(compareFile);
	exclusions.sort(compareExclusion);
	if (
		exclusions.some((item) => item.reason === "credential") &&
		!gaps.includes(CREDENTIAL_GAP)
	)
		gaps.push(CREDENTIAL_GAP);
	const complete =
		gaps.length === 0 &&
		!exclusions.some((item) => item.reason === "credential");
	const warnings = [CALLER_BARRIER_WARNING];
	const manifest: CheckpointManifest = {
		version: MANIFEST_VERSION,
		id: newCheckpointId(),
		createdAt: new Date().toISOString(),
		reason,
		complete,
		coverageGaps: gaps,
		exclusions,
		files,
		warnings,
	};
	if (exportGit) {
		const gitWarning = exportManifestToGit(historyRoot, manifest);
		if (gitWarning) warnings.push(gitWarning);
	}
	writeManifest(historyRoot, manifest);
	return manifest;
}

function addWalGaps(component: string, paths: string[], gaps: string[]): void {
	const set = new Set(paths);
	for (const path of paths) {
		if (!path.endsWith(".sqlite-wal")) continue;
		const main = path.slice(0, -"-wal".length);
		if (set.has(main)) continue;
		const gap = `sqlite wal captured without main database: ${component}/${path}`;
		if (!gaps.includes(gap)) gaps.push(gap);
	}
}

function compareFile(a: ManifestFile, b: ManifestFile): number {
	if (a.component !== b.component) return a.component < b.component ? -1 : 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function compareExclusion(a: ManifestExclusion, b: ManifestExclusion): number {
	if (a.component !== b.component) return a.component < b.component ? -1 : 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
