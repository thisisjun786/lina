import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { authorFileDigest } from "../../packages/lina-codex/src/author-native-policy.ts";
import { checkedDirectory } from "../../packages/lina-core/src/attachments/filesystem.ts";

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
