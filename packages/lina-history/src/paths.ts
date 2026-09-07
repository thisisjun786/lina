import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { CheckpointError } from "./errors.ts";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
const COMPONENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const CHECKPOINT_ID = /^chk_[0-9a-f]{32}$/;
const RESERVED = new Set([
	"objects",
	"checkpoints",
	"vcs",
	"lock",
	"restore-review.json",
]);

export function assertComponentName(name: string): string {
	if (!COMPONENT_NAME.test(name) || RESERVED.has(name))
		throw new CheckpointError(
			"invalid-input",
			`invalid component name: ${name}`,
		);
	return name;
}

export function assertCheckpointId(id: string): string {
	if (!CHECKPOINT_ID.test(id))
		throw new CheckpointError("invalid-input", `invalid checkpoint id: ${id}`);
	return id;
}

export function assertReason(reason: string): string {
	if (
		typeof reason !== "string" ||
		reason.trim() === "" ||
		reason.length > 1024
	)
		throw new CheckpointError(
			"invalid-input",
			"reason must be a non-empty string",
		);
	return reason;
}

export function normalizeGaps(gaps: string[] | undefined): string[] {
	if (gaps === undefined) return [];
	if (!Array.isArray(gaps) || gaps.length > 50)
		throw new CheckpointError("invalid-input", "invalid coverageGaps");
	const out: string[] = [];
	for (const gap of gaps) {
		if (typeof gap !== "string" || gap.trim() === "" || gap.length > 1024)
			throw new CheckpointError("invalid-input", "invalid coverage gap");
		if (!out.includes(gap)) out.push(gap);
	}
	return out;
}

export function resolveDirectory(path: string, create: boolean): string {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	const parts = absolute.slice(current.length).split(sep).filter(Boolean);
	for (const part of parts) {
		current = join(current, part);
		let stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat && create) {
			try {
				mkdirSync(current, { mode: DIR_MODE });
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
			throw new CheckpointError("unsafe-path", `unsafe directory: ${current}`);
	}
	return absolute;
}

export function resolveExistingHistory(path: string): string {
	const absolute = resolve(path);
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	if (!stat)
		throw new CheckpointError(
			"not-found",
			`history root not found: ${absolute}`,
		);
	return resolveDirectory(path, false);
}

export function posixRel(root: string, absoluteFile: string): string {
	const rel = relative(root, absoluteFile);
	if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
		throw new CheckpointError(
			"unsafe-path",
			`path escapes component root: ${absoluteFile}`,
		);
	return rel.split(sep).join("/");
}

export function inside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertDisjointHistory(
	historyRoot: string,
	componentRoot: string,
): void {
	const history = resolve(historyRoot);
	const component = resolve(componentRoot);
	if (inside(history, component) || inside(component, history))
		throw new CheckpointError(
			"invalid-input",
			`history root overlaps component: ${componentRoot}`,
		);
}

export function classifyExclusion(
	relativePath: string,
): "lease" | "credential" | "installation-lock" | "regenerable" | undefined {
	const base = relativePath.split("/").pop() ?? relativePath;
	const parts = relativePath.split("/");
	if (base === "owner.sqlite" || base.startsWith("owner.sqlite-"))
		return "lease";
	if (
		base === "installation-lock.sqlite" ||
		base.startsWith("installation-lock.sqlite-")
	)
		return "installation-lock";
	if (/\.lina-lease\.sqlite(?:-.*)?$/.test(base)) return "lease";
	if (
		base === ".env" ||
		base.startsWith(".env.") ||
		base === "credentials.json" ||
		base === "auth.json" ||
		base === "secrets.json" ||
		base.endsWith(".pem") ||
		base.endsWith(".key") ||
		base.endsWith(".p12") ||
		base.endsWith(".pfx") ||
		base === "id_rsa" ||
		base === "id_ed25519" ||
		parts.includes("credentials") ||
		(base === "config.toml" && parts.includes("codex-home"))
	)
		return "credential";
	if (base.includes(".sqlite") && base.endsWith("-shm")) return "regenerable";
	return undefined;
}

export function writePrivateFile(path: string, bytes: Uint8Array): void {
	resolveDirectory(dirname(path), true);
	const fd = openSync(
		path,
		constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			constants.O_NOFOLLOW,
		FILE_MODE,
	);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
		fchmodSync(fd, FILE_MODE);
	} finally {
		closeSync(fd);
	}
}

export function atomicWrite(path: string, bytes: Uint8Array): void {
	const directory = dirname(path);
	resolveDirectory(directory, true);
	const temporary = join(directory, `.tmp-${process.pid}-${Date.now()}`);
	try {
		writePrivateFile(temporary, bytes);
		renameSync(temporary, path);
		fsyncDirectory(directory);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			/* temp already renamed or missing */
		}
	}
}

export function fsyncDirectory(path: string): void {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function withHistoryLock<T>(historyRoot: string, fn: () => T): T {
	// Preserve a pre-existing legacy lock for explicit recovery; new writers use
	// a process-held SQLite lock that is released even on SIGKILL.
	if (lstatSync(join(historyRoot, ".lock"), { throwIfNoEntry: false }))
		throw new CheckpointError(
			"busy",
			"history root is busy (legacy lock requires review)",
		);
	const lock = acquireInstallationLock(historyRoot);
	try {
		return fn();
	} finally {
		lock.close();
	}
}

export function assertSafeAncestors(path: string): void {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	const parts = absolute.slice(current.length).split(sep).filter(Boolean);
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) return;
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new CheckpointError("unsafe-path", `unsafe directory: ${current}`);
	}
}

export function joinPosix(
	target: string,
	component: string,
	rel: string,
): string {
	try {
		assertComponentName(component);
	} catch {
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	}
	const parts = rel.split("/");
	if (
		parts.some(
			(part) =>
				part === "" || part === "." || part === ".." || part.includes("\\"),
		)
	)
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	const dest = join(target, component, ...parts);
	if (!inside(dest, target) || resolve(dest) === resolve(target))
		throw new CheckpointError("corrupt", "checkpoint manifest is corrupt");
	return dest;
}
