import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SOCIAL_PROCESS_LIMITS } from "./limits.ts";

type Failure = "aborted" | "timeout" | "output_limit" | "process_exit" | "io";
export class SocialProcessError extends Error {
	constructor(
		readonly reason: Failure,
		readonly pid: number | null,
		readonly exitCode: number | null,
	) {
		super(`Social engine process ${reason}`);
	}
}
type ProcessRequest = {
	entrypoint: string;
	input: string;
	signal: AbortSignal;
	timeoutMs?: number;
	memoryBytes?: number;
	maxBytes?: number;
};
let running = 0;
export function reducedLimit(
	value: number | undefined,
	maximum: number,
): number {
	const limit = value ?? maximum;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
		throw Error("Invalid social engine process limit");
	return limit;
}

/** Fixed limiter and Bun argv; entrypoint is trusted host code, never request data. */
export async function runSocialProcess(
	request: ProcessRequest,
): Promise<{ output: string; pid: number }> {
	const timeoutMs = reducedLimit(
		request.timeoutMs,
		SOCIAL_PROCESS_LIMITS.timeoutMs,
	);
	const memoryBytes = reducedLimit(
		request.memoryBytes,
		SOCIAL_PROCESS_LIMITS.memoryBytes,
	);
	const maxBytes = reducedLimit(
		request.maxBytes,
		SOCIAL_PROCESS_LIMITS.maxBytes,
	);
	if (!isAbsolute(request.entrypoint))
		throw Error("Social worker path must be absolute");
	if (Buffer.byteLength(request.input) > maxBytes)
		throw Error("Social engine input limit");
	if (request.signal.aborted)
		throw new SocialProcessError("aborted", null, null);
	if (process.platform !== "linux")
		throw Error("Social engine requires Linux prlimit");
	if (running >= SOCIAL_PROCESS_LIMITS.concurrent)
		throw Error("Social engine capacity reached");
	running++;
	let cwd: string | undefined;
	try {
		cwd = await mkdtemp(join(tmpdir(), "lina-social-"));
		if (request.signal.aborted)
			throw new SocialProcessError("aborted", null, null);
		return await execute(request, cwd, { timeoutMs, memoryBytes, maxBytes });
	} finally {
		running--;
		if (cwd) await rmdir(cwd);
	}
}

function execute(
	request: ProcessRequest,
	cwd: string,
	limits: { timeoutMs: number; memoryBytes: number; maxBytes: number },
): Promise<{ output: string; pid: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"/usr/bin/prlimit",
			[
				"--core=0",
				`--data=${limits.memoryBytes}`,
				`--cpu=${SOCIAL_PROCESS_LIMITS.cpuSeconds}`,
				"--fsize=0",
				"--",
				process.execPath,
				"--smol",
				"--no-install",
				"--no-env-file",
				request.entrypoint,
			],
			{
				cwd,
				env: { LANG: "C" },
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			},
		);
		let reason: Failure | null = null;
		let stdoutBytes = 0,
			stderrBytes = 0;
		const chunks: Buffer[] = [];
		const stop = (failure: Failure) => {
			reason ??= failure;
			child.kill("SIGKILL");
		};
		const abort = () => stop("aborted");
		request.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > limits.maxBytes) stop("output_limit");
			else if (!reason) chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > SOCIAL_PROCESS_LIMITS.stderrBytes) stop("output_limit");
		});
		child.on("error", () => stop("io"));
		child.stdin.on("error", () => stop("io"));
		// close follows exit and pipe closure; signalling alone never settles this promise.
		child.on("close", (code, exitSignal) => {
			clearTimeout(timer);
			request.signal.removeEventListener("abort", abort);
			if (reason || code !== 0 || exitSignal || !child.pid) {
				reject(
					new SocialProcessError(
						reason ?? "process_exit",
						child.pid ?? null,
						code,
					),
				);
			} else
				resolve({
					output: Buffer.concat(chunks).toString("utf8"),
					pid: child.pid,
				});
		});
		child.stdin.end(request.input);
		if (request.signal.aborted) abort();
	});
}
