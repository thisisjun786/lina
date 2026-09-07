import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointError } from "./errors.ts";
import {
	assertComponentName,
	assertSafeAncestors,
	atomicWrite,
	resolveDirectory,
} from "./paths.ts";
import {
	type CheckpointManifest,
	MANIFEST_VERSION,
	type ManifestExclusion,
	type ManifestFile,
} from "./types.ts";

const MANIFEST_KEYS = [
	"version",
	"id",
	"createdAt",
	"reason",
	"complete",
	"coverageGaps",
	"exclusions",
	"files",
	"warnings",
] as const;

export function manifestPath(historyRoot: string, id: string): string {
	return join(historyRoot, "checkpoints", id, "manifest.json");
}

export function writeManifest(
	historyRoot: string,
	manifest: CheckpointManifest,
): void {
	const path = manifestPath(historyRoot, manifest.id);
	resolveDirectory(join(historyRoot, "checkpoints", manifest.id), true);
	atomicWrite(path, Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`));
}

export function readManifest(
	historyRoot: string,
	id: string,
): CheckpointManifest {
	const path = manifestPath(historyRoot, id);
	assertSafeAncestors(path);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat)
		throw new CheckpointError("not-found", `checkpoint not found: ${id}`);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	}
	return parseManifest(parsed, id);
}

export function parseManifest(
	value: unknown,
	expectedId?: string,
): CheckpointManifest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!MANIFEST_KEYS.includes(key as (typeof MANIFEST_KEYS)[number]))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	}
	if (record["version"] !== MANIFEST_VERSION)
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	const id = requiredString(record["id"], "id");
	if (expectedId !== undefined && id !== expectedId)
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	const files = parseFiles(record["files"]);
	const exclusions = parseExclusions(record["exclusions"]);
	const coverageGaps = stringList(record["coverageGaps"]);
	const paths = new Set<string>();
	for (const file of files) {
		const key = `${file.component}/${file.path}`;
		if (paths.has(key))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		paths.add(key);
	}
	const claimed = record["complete"] === true;
	const complete =
		claimed &&
		coverageGaps.length === 0 &&
		!exclusions.some((item) => item.reason === "credential");
	return {
		version: MANIFEST_VERSION,
		id,
		createdAt: requiredString(record["createdAt"], "createdAt"),
		reason: requiredString(record["reason"], "reason"),
		complete,
		coverageGaps,
		exclusions,
		files,
		warnings: stringList(record["warnings"]),
	};
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new CheckpointError(
			"corrupt",
			`checkpoint manifest is corrupt: ${field}`,
		);
	return value;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value))
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	return value.map((item) => requiredString(item, "list"));
}

function parseFiles(value: unknown): ManifestFile[] {
	if (!Array.isArray(value))
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		const record = item as Record<string, unknown>;
		const path = requiredString(record["path"], "path");
		if (
			path.includes("\\") ||
			path.split("/").some((part) => part === ".." || part === "")
		)
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		const hash = requiredString(record["hash"], "hash");
		if (!/^[0-9a-f]{64}$/.test(hash))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		const size = record["size"];
		if (typeof size !== "number" || !Number.isInteger(size) || size < 0)
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		return {
			component: parsedComponent(record["component"]),
			path,
			hash,
			size,
			mtime: requiredString(record["mtime"], "mtime"),
		};
	});
}

function parseExclusions(value: unknown): ManifestExclusion[] {
	if (!Array.isArray(value))
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	const reasons = new Set([
		"lease",
		"credential",
		"installation-lock",
		"regenerable",
	]);
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		const record = item as Record<string, unknown>;
		const reason = requiredString(record["reason"], "reason");
		if (!reasons.has(reason))
			throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
		return {
			component: parsedComponent(record["component"]),
			path: requiredString(record["path"], "path"),
			reason: reason as ManifestExclusion["reason"],
		};
	});
}

function parsedComponent(value: unknown): string {
	const name = requiredString(value, "component");
	try {
		return assertComponentName(name);
	} catch {
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	}
}
