export const MANIFEST_VERSION = 1;
export const REVIEW_MARKER = "restore-review.json";
export const CALLER_BARRIER_WARNING =
	"Caller owns the installation and session barrier; this library does not prevent concurrent source writes.";

export type CheckpointComponent = {
	name: string;
	root: string;
};

export type CreateCheckpointInput = {
	historyRoot: string;
	components: CheckpointComponent[];
	reason: string;
	coverageGaps?: string[];
	exportGit?: boolean;
};

export type ExclusionReason =
	| "lease"
	| "credential"
	| "installation-lock"
	| "regenerable";

export type ManifestExclusion = {
	component: string;
	path: string;
	reason: ExclusionReason;
};

export type ManifestFile = {
	component: string;
	path: string;
	hash: string;
	size: number;
	mtime: string;
};

export type CheckpointManifest = {
	version: typeof MANIFEST_VERSION;
	id: string;
	createdAt: string;
	reason: string;
	complete: boolean;
	coverageGaps: string[];
	exclusions: ManifestExclusion[];
	files: ManifestFile[];
	warnings: string[];
};

export type CheckpointSummary = {
	id: string;
	createdAt: string;
	reason: string;
	complete: boolean;
	coverageGaps: string[];
};

export type CheckpointDiffEntry = {
	component: string;
	path: string;
};

export type CheckpointDiffChange = CheckpointDiffEntry & {
	leftHash: string;
	rightHash: string;
};

export type CheckpointDiff = {
	left: string;
	right: string;
	added: CheckpointDiffEntry[];
	removed: CheckpointDiffEntry[];
	changed: CheckpointDiffChange[];
};

export type RestoreResult = {
	target: string;
	checkpointId: string;
	reviewMarker: string;
	complete: boolean;
	coverageGaps: string[];
};

export type RestoreReview = {
	version: typeof MANIFEST_VERSION;
	checkpointId: string;
	restoredAt: string;
	startable: false;
	reviewRequired: true;
	complete: boolean;
	coverageGaps: string[];
	exclusions: ManifestExclusion[];
	requires: string[];
	warnings: string[];
};
