import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	parseSessionContextPolicy,
	type SessionContextPolicy,
} from "../../lina-runtime/src/context-policy.ts";

export const CODEX_SESSION_ENGINE = "codex";
export const CODEX_SESSION_VERSION = 2;

export type CodexThreadCreate = "idle" | "pending" | "committed";

export type CodexSessionHeader = {
	type: "session";
	engine: typeof CODEX_SESSION_ENGINE;
	version: 1 | 2;
	contextPolicy?: SessionContextPolicy | null;
	nativeEpoch?: number;
	contextTransition?: {
		id: string;
		target: SessionContextPolicy;
		phase: "prepared" | "pending";
	} | null;
	id: string;
	cwd: string;
	nativeThreadId: string | null;
	threadCreate: CodexThreadCreate;
	rolloutPath: string | null;
	dynamicToolsResume: "supported" | "unsupported" | "unverified";
	createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFirstLine(sessionFile: string): string {
	const fd = openSync(sessionFile, "r");
	const buffer = Buffer.alloc(8192);
	let bytes: number;
	try {
		bytes = readSync(fd, buffer, 0, buffer.length, 0);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8", 0, bytes).split("\n", 1)[0] ?? "";
}

function parseHeader(raw: string): CodexSessionHeader {
	const header: unknown = JSON.parse(raw);
	const invalid = () =>
		new Error("Session header does not match this workspace/version");
	const text = (v: unknown): v is string =>
		typeof v === "string" && v.trim().length > 0;
	if (
		!isRecord(header) ||
		header["type"] !== "session" ||
		header["engine"] !== CODEX_SESSION_ENGINE ||
		(header["version"] !== 1 && header["version"] !== 2) ||
		!text(header["id"]) ||
		!text(header["cwd"]) ||
		!text(header["createdAt"])
	)
		throw invalid();
	const keys = [
		"type",
		"engine",
		"version",
		"id",
		"cwd",
		"nativeThreadId",
		"threadCreate",
		"rolloutPath",
		"dynamicToolsResume",
		"createdAt",
	];
	if (header["version"] === 2)
		keys.push("contextPolicy", "nativeEpoch", "contextTransition");
	if (
		Object.keys(header).length !== keys.length ||
		Object.keys(header).some((k) => !keys.includes(k))
	)
		throw invalid();
	const nativeThreadId = header["nativeThreadId"];
	const threadCreate = header["threadCreate"];
	const rolloutPath = header["rolloutPath"];
	const dynamicToolsResume = header["dynamicToolsResume"];
	if (
		(nativeThreadId !== null && !text(nativeThreadId)) ||
		(rolloutPath !== null && !text(rolloutPath)) ||
		typeof dynamicToolsResume !== "string" ||
		!["supported", "unsupported", "unverified"].includes(dynamicToolsResume) ||
		typeof threadCreate !== "string" ||
		!["idle", "pending", "committed"].includes(threadCreate) ||
		(threadCreate === "committed") !== (nativeThreadId !== null)
	)
		throw invalid();
	if (header["version"] === 2) {
		const epoch = header["nativeEpoch"];
		if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
			throw invalid();
		const policy =
			header["contextPolicy"] === null
				? null
				: parseSessionContextPolicy(header["contextPolicy"]);
		const transition = header["contextTransition"];
		if (transition !== null) {
			if (
				!isRecord(transition) ||
				Object.keys(transition).length !== 3 ||
				typeof transition["id"] !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
					transition["id"],
				) ||
				(transition["phase"] !== "prepared" &&
					transition["phase"] !== "pending") ||
				nativeThreadId !== null ||
				(transition["phase"] === "pending"
					? threadCreate !== "pending"
					: threadCreate !== "idle")
			)
				throw invalid();
			parseSessionContextPolicy(transition["target"]);
		} else if (!policy || epoch < 1 || threadCreate !== "committed")
			throw invalid();
		if (policy === null && (epoch !== 0 || transition === null))
			throw invalid();
	}
	// All authority fields are checked at the persisted-file boundary above.
	return header as CodexSessionHeader;
}

function assertRegularFile(sessionFile: string): void {
	const stat = lstatSync(sessionFile);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("Session must be a regular owned file");
}

function writeHeader(
	sessionFile: string,
	header: CodexSessionHeader,
	metadata: readonly unknown[] = [],
): void {
	const encoded = JSON.stringify(header);
	if (Buffer.byteLength(encoded) >= 8192)
		throw new Error("Session header exceeds limit");
	parseHeader(encoded);
	const rest = (() => {
		const text = readFileSync(sessionFile, "utf8");
		const idx = text.indexOf("\n");
		return idx >= 0 ? text.slice(idx + 1) : "";
	})();
	const separator = rest && !rest.endsWith("\n") ? "\n" : "";
	const body = `${encoded}\n${rest}${separator}${metadata.map((item) => `${JSON.stringify(item)}\n`).join("")}`;
	const tmp = join(dirname(sessionFile), `.${header.id}-${randomUUID()}.tmp`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		writeFileSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, sessionFile);
	const dir = openSync(dirname(sessionFile), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

export function inspectCodexSessionFile(
	sessionFile: string,
	workspace: string,
): void {
	const cwd = realpathSync(workspace);
	assertRegularFile(sessionFile);
	const stat = lstatSync(sessionFile);
	if (stat.size === 0) return;
	const header = parseHeader(readFirstLine(sessionFile));
	if (header.cwd !== cwd)
		throw new Error("Session header does not match this workspace/version");
}

export function readCodexSessionHeader(
	sessionFile: string,
	workspace: string,
): CodexSessionHeader {
	inspectCodexSessionFile(sessionFile, workspace);
	if (lstatSync(sessionFile).size === 0)
		throw new Error("Session header is missing");
	const header = parseHeader(readFirstLine(sessionFile));
	if (header.cwd !== realpathSync(workspace))
		throw new Error("Session header does not match this workspace/version");
	return header;
}

export function initializeCodexSessionFile(
	sessionFile: string,
	workspace: string,
	policy?: SessionContextPolicy,
): { sessionId: string; sessionFile: string } {
	const requested =
		policy === undefined ? undefined : parseSessionContextPolicy(policy);
	const cwd = realpathSync(workspace);
	try {
		closeSync(openSync(sessionFile, "wx", 0o600));
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		)
			throw error;
	}
	inspectCodexSessionFile(sessionFile, cwd);
	if (lstatSync(sessionFile).size === 0) {
		const header: CodexSessionHeader = {
			type: "session",
			engine: CODEX_SESSION_ENGINE,
			version: 1,
			id: randomUUID(),
			cwd,
			nativeThreadId: null,
			threadCreate: "idle",
			rolloutPath: null,
			dynamicToolsResume: "unverified",
			createdAt: new Date().toISOString(),
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 });
		if (requested) prepareCodexContext(sessionFile, cwd, requested);
		return { sessionId: header.id, sessionFile: realpathSync(sessionFile) };
	}
	const header = readCodexSessionHeader(sessionFile, cwd);
	if (header.version === 2 && !requested)
		throw new Error("Explicit context policy is required for this session");
	if (
		header.contextTransition &&
		requested?.scopeDigest !== header.contextTransition.target.scopeDigest
	)
		throw new Error("Context transition target changed; attention required");
	if (header.threadCreate === "pending" && !header.nativeThreadId) {
		throw new Error(
			"Ambiguous Codex thread creation; refusing to start a second thread. Restore or unarchive the native thread, then retry.",
		);
	}
	return { sessionId: header.id, sessionFile: realpathSync(sessionFile) };
}

export function markCodexThreadPending(
	sessionFile: string,
	workspace: string,
): CodexSessionHeader {
	const header = readCodexSessionHeader(sessionFile, workspace);
	if (header.nativeThreadId)
		throw new Error("Native Codex thread is already bound");
	if (header.threadCreate === "pending")
		throw new Error(
			"Ambiguous Codex thread creation; refusing to start a second thread. Restore or unarchive the native thread, then retry.",
		);
	const next = {
		...header,
		threadCreate: "pending" as const,
		...(header.contextTransition
			? {
					contextTransition: {
						...header.contextTransition,
						phase: "pending" as const,
					},
				}
			: {}),
	};
	writeHeader(sessionFile, next);
	return next;
}

export function commitCodexThread(
	sessionFile: string,
	workspace: string,
	nativeThreadId: string,
	rolloutPath?: string,
): CodexSessionHeader {
	const header = readCodexSessionHeader(sessionFile, workspace);
	if (
		(header.version === 2 && header.threadCreate !== "pending") ||
		header.nativeThreadId ||
		!nativeThreadId?.trim()
	)
		throw new Error("Codex thread commit requires pending creation");
	if (
		header.version === 2 &&
		readCodexContextBindings(sessionFile, workspace).some(
			(binding) => binding.nativeThreadId === nativeThreadId,
		)
	)
		throw new Error("Native context transition cannot reuse a prior thread");
	const next: CodexSessionHeader = {
		...header,
		...(header.contextTransition
			? {
					nativeEpoch: (header.nativeEpoch ?? 0) + 1,
					contextPolicy: header.contextTransition.target,
					contextTransition: null,
				}
			: {}),
		nativeThreadId,
		threadCreate: "committed",
		rolloutPath: rolloutPath ?? header.rolloutPath,
	};
	writeHeader(
		sessionFile,
		next,
		header.contextTransition
			? [
					{
						type: "context_transition",
						version: 1,
						id: header.contextTransition.id,
						phase: "committed",
						nativeEpoch: next.nativeEpoch,
						nativeThreadId,
						scopeDigest: next.contextPolicy?.scopeDigest,
					},
				]
			: [],
	);
	return next;
}

export function prepareCodexContext(
	sessionFile: string,
	workspace: string,
	policy: SessionContextPolicy,
): CodexSessionHeader {
	const target = parseSessionContextPolicy(policy);
	const header = readCodexSessionHeader(sessionFile, workspace);
	if (header.threadCreate === "pending")
		throw new Error("Ambiguous Codex thread creation; attention required");
	if (header.contextTransition) {
		if (header.contextTransition.target.scopeDigest !== target.scopeDigest)
			throw new Error("Context transition target changed; attention required");
		return header;
	}
	if (header.contextPolicy?.scopeDigest === target.scopeDigest) return header;
	if ((header.nativeEpoch ?? 0) >= Number.MAX_SAFE_INTEGER)
		throw new Error("Native epoch exhausted");
	const id = randomUUID();
	const next: CodexSessionHeader = {
		...header,
		version: 2,
		nativeEpoch: header.nativeEpoch ?? 0,
		contextPolicy: header.contextPolicy ?? null,
		contextTransition: { id, target, phase: "prepared" },
		nativeThreadId: null,
		rolloutPath: null,
		threadCreate: "idle",
		dynamicToolsResume: "unverified",
	};
	writeHeader(sessionFile, next, [
		{
			type: "context_transition",
			version: 1,
			id,
			phase: "prepared",
			prior: {
				nativeEpoch: header.nativeEpoch ?? 0,
				nativeThreadId: header.nativeThreadId,
				rolloutPath: header.rolloutPath,
				contextPolicy: header.contextPolicy ?? null,
			},
			target,
		},
	]);
	return next;
}

export function loadCodexJournal(sessionFile: string): unknown[] {
	const text = readFileSync(sessionFile, "utf8");
	return text
		.split("\n")
		.slice(1)
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as unknown);
}

export function appendCodexJournal(sessionFile: string, entry: unknown): void {
	const fd = openSync(sessionFile, "a", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export type CodexNativeBinding = Readonly<{
	nativeEpoch: number;
	nativeThreadId: string | null;
	contextPolicy: SessionContextPolicy | null;
}>;

/** Decode the atomic binding journal, including its link back to the current header. */
export function readCodexContextBindings(
	sessionFile: string,
	workspace: string,
): readonly CodexNativeBinding[] {
	const header = readCodexSessionHeader(sessionFile, workspace);
	const bindings = new Map<number, CodexNativeBinding>();
	const ids = new Set<string>();
	let pending:
		| { id: string; target: SessionContextPolicy; epoch: number }
		| undefined;
	let committed: CodexNativeBinding | undefined;
	function invalid(): never {
		throw new Error("Invalid native context transition binding metadata");
	}
	for (const row of loadCodexJournal(sessionFile)) {
		if (!isRecord(row) || row["type"] !== "context_transition") continue;
		const id = row["id"];
		if (
			row["version"] !== 1 ||
			typeof id !== "string" ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
		)
			invalid();
		if (row["phase"] === "prepared") {
			if (Object.keys(row).length !== 6 || pending || ids.has(id)) invalid();
			const prior = row["prior"];
			if (!isRecord(prior) || Object.keys(prior).length !== 4) invalid();
			const epoch = prior["nativeEpoch"],
				thread = prior["nativeThreadId"],
				path = prior["rolloutPath"];
			if (
				typeof epoch !== "number" ||
				!Number.isSafeInteger(epoch) ||
				epoch < 0 ||
				(thread !== null && (typeof thread !== "string" || !thread)) ||
				(path !== null && (typeof path !== "string" || !path))
			)
				invalid();
			const policy =
				prior["contextPolicy"] === null
					? null
					: parseSessionContextPolicy(prior["contextPolicy"]);
			if ((epoch === 0) !== (policy === null) || (epoch > 0 && thread === null))
				invalid();
			if (
				committed &&
				(epoch !== committed.nativeEpoch ||
					thread !== committed.nativeThreadId ||
					policy?.scopeDigest !== committed.contextPolicy?.scopeDigest)
			)
				invalid();
			if (!committed && epoch !== 0) invalid();
			bindings.set(
				epoch,
				Object.freeze({
					nativeEpoch: epoch,
					nativeThreadId: thread,
					contextPolicy: policy,
				}),
			);
			pending = { id, target: parseSessionContextPolicy(row["target"]), epoch };
			ids.add(id);
		} else if (row["phase"] === "committed") {
			if (
				Object.keys(row).length !== 7 ||
				!pending ||
				id !== pending.id ||
				row["nativeEpoch"] !== pending.epoch + 1 ||
				row["scopeDigest"] !== pending.target.scopeDigest ||
				typeof row["nativeThreadId"] !== "string" ||
				!row["nativeThreadId"]
			)
				invalid();
			if (
				[...bindings.values()].some(
					(b) => b.nativeThreadId === row["nativeThreadId"],
				)
			)
				invalid();
			committed = Object.freeze({
				nativeEpoch: pending.epoch + 1,
				nativeThreadId: row["nativeThreadId"],
				contextPolicy: pending.target,
			});
			bindings.set(committed.nativeEpoch, committed);
			pending = undefined;
		} else invalid();
	}
	if (header.version === 2) {
		if (header.contextTransition) {
			if (
				!pending ||
				pending.id !== header.contextTransition.id ||
				pending.target.scopeDigest !==
					header.contextTransition.target.scopeDigest ||
				pending.epoch !== header.nativeEpoch
			)
				invalid();
			bindings.set(
				pending.epoch + 1,
				Object.freeze({
					nativeEpoch: pending.epoch + 1,
					nativeThreadId: null,
					contextPolicy: pending.target,
				}),
			);
		} else if (
			pending ||
			!committed ||
			committed.nativeEpoch !== header.nativeEpoch ||
			committed.nativeThreadId !== header.nativeThreadId ||
			committed.contextPolicy?.scopeDigest !== header.contextPolicy?.scopeDigest
		)
			invalid();
	} else if (ids.size) invalid();
	return Object.freeze([...bindings.values()]);
}
