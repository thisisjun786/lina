import { randomUUID } from "node:crypto";
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CODEX_SESSION_ENGINE = "codex";
export const CODEX_SESSION_VERSION = 1;

export type CodexThreadCreate = "idle" | "pending" | "committed";

export type CodexSessionHeader = {
	type: "session";
	engine: typeof CODEX_SESSION_ENGINE;
	version: typeof CODEX_SESSION_VERSION;
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
	if (
		!isRecord(header) ||
		header["type"] !== "session" ||
		header["engine"] !== CODEX_SESSION_ENGINE ||
		header["version"] !== CODEX_SESSION_VERSION ||
		typeof header["id"] !== "string" ||
		typeof header["cwd"] !== "string" ||
		typeof header["createdAt"] !== "string"
	)
		throw new Error("Session header does not match this workspace/version");
	const threadCreate = header["threadCreate"];
	if (
		threadCreate !== "idle" &&
		threadCreate !== "pending" &&
		threadCreate !== "committed"
	)
		throw new Error("Session header does not match this workspace/version");
	const nativeThreadId = header["nativeThreadId"];
	const rolloutPath = header["rolloutPath"];
	const dynamicToolsResume = header["dynamicToolsResume"];
	return {
		type: "session",
		engine: CODEX_SESSION_ENGINE,
		version: CODEX_SESSION_VERSION,
		id: header["id"],
		cwd: header["cwd"],
		nativeThreadId: typeof nativeThreadId === "string" ? nativeThreadId : null,
		threadCreate,
		rolloutPath: typeof rolloutPath === "string" ? rolloutPath : null,
		dynamicToolsResume:
			dynamicToolsResume === "supported" || dynamicToolsResume === "unsupported"
				? dynamicToolsResume
				: "unverified",
		createdAt: header["createdAt"],
	};
}

function assertRegularFile(sessionFile: string): void {
	const stat = lstatSync(sessionFile);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("Session must be a regular owned file");
}

function writeHeader(sessionFile: string, header: CodexSessionHeader): void {
	const rest = (() => {
		const text = readFileSync(sessionFile, "utf8");
		const idx = text.indexOf("\n");
		return idx >= 0 ? text.slice(idx + 1) : "";
	})();
	const body = `${JSON.stringify(header)}\n${rest}`;
	const tmp = join(dirname(sessionFile), `.${header.id}.tmp`);
	writeFileSync(tmp, body, { mode: 0o600 });
	renameSync(tmp, sessionFile);
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
): { sessionId: string; sessionFile: string } {
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
			version: CODEX_SESSION_VERSION,
			id: randomUUID(),
			cwd,
			nativeThreadId: null,
			threadCreate: "idle",
			rolloutPath: null,
			dynamicToolsResume: "unverified",
			createdAt: new Date().toISOString(),
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 });
		return { sessionId: header.id, sessionFile: realpathSync(sessionFile) };
	}
	const header = readCodexSessionHeader(sessionFile, cwd);
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
	const next = { ...header, threadCreate: "pending" as const };
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
	const next: CodexSessionHeader = {
		...header,
		nativeThreadId,
		threadCreate: "committed",
		rolloutPath: rolloutPath ?? header.rolloutPath,
	};
	writeHeader(sessionFile, next);
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
	} finally {
		closeSync(fd);
	}
}
