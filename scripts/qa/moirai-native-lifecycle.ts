import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
	AUTHOR_MANAGED_PATHS,
	type AuthorNativePlan,
	authorFileDigest,
	authorFingerprint,
	authorHash,
	authorManagedFiles,
} from "../../packages/lina-codex/src/author-native-policy.ts";
import { checkedDirectory } from "../../packages/lina-core/src/attachments/filesystem.ts";
import { canonicalLifeJson } from "../../packages/lina-core/src/world/life-json.ts";

/** Repository mode includes tracked files and non-ignored additions, including the lockfile. */
export function probeSourceIdentity(source: string | readonly string[]) {
	const paths =
		typeof source === "string"
			? [
					...new Set(
						execFileSync(
							"git",
							[
								"-C",
								source,
								"ls-files",
								"--cached",
								"--others",
								"--exclude-standard",
								"-z",
							],
							{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
						)
							.split("\0")
							.filter(Boolean),
					),
				]
					.sort()
					.map((path) => resolve(source, path))
			: source;
	if (!paths.length) throw Error("Probe source is empty");
	const files = Object.fromEntries(
		paths.map((path) => [resolve(path), authorFileDigest(path)]),
	);
	return { files, sha256: authorHash(canonicalLifeJson(files)) };
}

export function probeFingerprint(
	plan: AuthorNativePlan,
	sourcePaths: string | readonly string[],
	requestOptions: Readonly<Record<string, unknown>>,
	managedPaths: readonly string[] = AUTHOR_MANAGED_PATHS,
) {
	const managed = authorManagedFiles(managedPaths);
	if (canonicalLifeJson(managed) !== canonicalLifeJson(plan.managed))
		throw Error("Administrator-managed policy changed during probe");
	return authorHash(
		JSON.stringify({
			capability: authorFingerprint({ ...plan, managed }),
			source: probeSourceIdentity(sourcePaths).sha256,
			requestOptions,
		}),
	);
}

/** Observe the exact resolved executable; a version label alone cannot identify a build. */
export function probeExecutableIdentity(command: string) {
	const path = realpathSync(command);
	const sha256 = authorFileDigest(path);
	const version = execFileSync(path, ["--version"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 4096,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	if (!version || authorFileDigest(path) !== sha256)
		throw Error("Executable changed or version unavailable");
	return { path, sha256, version };
}

/** Admission only: do not create evidence until the absolute outside-checkout path is checked. */
export function probeEvidenceRoot(value: string, repository: string): string {
	if (!isAbsolute(value)) throw Error("--root must be an absolute path");
	const root = resolve(value);
	const checkout = realpathSync(repository);
	if (root === checkout || root.startsWith(`${checkout}${sep}`))
		throw Error("--root must be outside the repository");
	checkedDirectory(dirname(root), false);
	return root;
}

/** A closed RPC channel is not proof its owned native process group has exited. */
export async function probeShutdown(rpc: {
	pid: number | undefined;
	close(): Promise<void>;
}) {
	const pid = rpc.pid;
	let closeError: string | null = null;
	try {
		await rpc.close();
	} catch (error) {
		closeError = error instanceof Error ? error.message : String(error);
	}
	let groupExited = false;
	let observationError: string | null = null;
	if (
		process.platform === "win32" ||
		!Number.isSafeInteger(pid) ||
		(pid ?? 0) <= 1
	) {
		observationError = "Owned process group unavailable";
	} else {
		try {
			process.kill(-(pid as number), 0);
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ESRCH"
			)
				groupExited = true;
			else
				observationError =
					error instanceof Error ? error.message : String(error);
		}
	}
	return {
		pid: pid ?? null,
		groupExited,
		closeError,
		observationError,
		observedAt: Date.now(),
	};
}
