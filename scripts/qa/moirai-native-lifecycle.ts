import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertAuthorFiles } from "../../packages/lina-codex/src/author-native-checks.ts";
import {
	AUTHOR_MANAGED_PATHS,
	type AuthorNativePlan,
	authorConfig,
	authorFileDigest,
	authorFingerprint,
	authorHash,
	authorManagedFiles,
	authorRecord,
} from "../../packages/lina-codex/src/author-native-policy.ts";
import { PROBE_MAX_RECORD_BYTES } from "../../packages/lina-codex/src/moirai-probe-state.ts";
import {
	type ProbeCapture,
	probeWireItems,
} from "../../packages/lina-codex/src/moirai-probe-transport.ts";
import {
	checkedDirectory,
	readRegular,
} from "../../packages/lina-core/src/attachments/filesystem.ts";
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
	assertAuthorFiles(plan, authorConfig(plan));
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

/** Read only an owned, stopped native session; thread/read omits opaque reasoning. */
export function probeStoredWire(
	home: string,
	snapshot: unknown,
	capture: ProbeCapture,
) {
	const thread = authorRecord(authorRecord(snapshot)["thread"]);
	const path = thread["path"];
	const sessions = resolve(home, "sessions");
	if (
		typeof path !== "string" ||
		!isAbsolute(path) ||
		!resolve(path).startsWith(`${sessions}${sep}`)
	)
		throw Error("Native rollout outside isolated sessions");
	const bytes = Buffer.from(readRegular(path, PROBE_MAX_RECORD_BYTES));
	const rows = bytes
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map((line) => authorRecord(JSON.parse(line)));
	const metadata = rows.filter((row) => row["type"] === "session_meta");
	if (
		metadata.length !== 1 ||
		authorRecord(metadata[0]?.["payload"])["id"] !== thread["id"]
	)
		throw Error("Native rollout identity mismatch");
	if (rows.some((row) => row["type"] === "compacted"))
		throw Error("Unexpected native compaction");
	const items = rows
		.filter((row) => row["type"] === "response_item")
		.map((row) => row["payload"]);
	if (
		!isDeepStrictEqual(probeWireItems(items), [
			...probeWireItems(capture.input),
			...probeWireItems(capture.output),
		])
	)
		throw Error("Persisted provider wire mismatch");
	const turns = thread["turns"];
	if (!Array.isArray(turns)) throw Error("Missing native rollout turns");
	const turnIds = turns.map((turn) => authorRecord(turn)["id"]);
	for (const type of ["task_started", "task_complete"]) {
		const ids = rows
			.filter((row) => row["type"] === "event_msg")
			.map((row) => authorRecord(row["payload"]))
			.filter((event) => event["type"] === type)
			.map((event) => event["turn_id"]);
		if (!isDeepStrictEqual(ids, turnIds))
			throw Error("Native rollout turn identity mismatch");
	}
	return {
		path,
		sha256: authorHash(bytes.toString("utf8")),
		responseItems: items.length,
	};
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
