import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { responseDeliveryCheck } from "./guarded-response.ts";

export type JsonRpcId = string | number;

const remoteErrors = new WeakSet<object>();

/** A decoded native error response; trusted fixtures may construct one explicitly. */
export class CodexRpcRemoteError extends Error {
	constructor(
		message: string,
		readonly code: number = -32603,
	) {
		super(message);
		this.name = "CodexRpcRemoteError";
		remoteErrors.add(this);
	}
}

export function isCodexRpcRemoteError(
	error: unknown,
): error is CodexRpcRemoteError {
	return typeof error === "object" && error !== null && remoteErrors.has(error);
}

export type CodexRpcNotification = {
	method: string;
	params: unknown;
};

export type CodexRpcRequestHandler = (
	method: string,
	params: unknown,
	/** Register trusted checks to run after serialization, immediately before writing. */
	beforeSend: (check: () => void) => void,
) => Promise<unknown>;

export type CodexRpcStdio = {
	input: Writable;
	output: Readable;
};

export type CodexRpcOptions = {
	command?: string;
	args?: readonly string[];
	env?: Record<string, string | undefined>;
	cwd?: string;
	timeoutMs?: number;
	shutdownGraceMs?: number;
	stdio?: CodexRpcStdio;
	ownsProcess?: boolean;
};

export type CodexRpc = {
	request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
		/** Trusted synchronous check after serialization, immediately before writing. */
		beforeSend?: () => void,
	): Promise<T>;
	notify(method: string, params?: unknown): void;
	subscribe(listener: (method: string, params: unknown) => void): () => void;
	onRequest(handler: CodexRpcRequestHandler): () => void;
	close(): Promise<void>;
	readonly closed: boolean;
	readonly pid: number | undefined;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Pending = {
	settle: (error: Error | undefined, result?: unknown) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	abort: (() => void) | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasId(
	value: Record<string, unknown>,
): value is Record<string, unknown> & { id: JsonRpcId } {
	return (
		"id" in value &&
		(typeof value["id"] === "string" || typeof value["id"] === "number")
	);
}

function errorMessage(value: unknown, fallback: string): string {
	if (!isRecord(value)) return fallback;
	const message = value["message"];
	return typeof message === "string" && message.trim() ? message : fallback;
}

export async function createCodexRpc(
	options: CodexRpcOptions = {},
): Promise<CodexRpc> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const spawned = !options.stdio;
	const ownsProcess = options.ownsProcess ?? spawned;
	let child: ChildProcess | undefined;
	let input: Writable;
	let output: Readable;
	if (options.stdio) {
		input = options.stdio.input;
		output = options.stdio.output;
	} else {
		const command = options.command ?? "codex";
		const args = options.args ?? ["app-server", "--stdio"];
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		child = spawn(command, [...args], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env,
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
		if (!child.stdin || !child.stdout)
			throw new Error("Codex app-server stdio is unavailable");
		input = child.stdin;
		output = child.stdout;
		child.stderr?.on("data", () => undefined);
	}

	let nextId = 1;
	let closed = false;
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	let closing: Promise<void> | undefined;
	const pending = new Map<JsonRpcId, Pending>();
	const listeners = new Set<(method: string, params: unknown) => void>();
	const requestHandlers = new Set<CodexRpcRequestHandler>();

	const emit = (method: string, params: unknown): void => {
		for (const listener of [...listeners]) {
			try {
				listener(method, params);
			} catch {
				listeners.delete(listener);
				shutdown(Error("Codex event consumer failed"), true);
			}
		}
	};

	const failPending = (error: Error): void => {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.abort?.();
			item.settle(error);
		}
		pending.clear();
	};

	const writeSafe = (value: unknown, beforeSend?: () => void): boolean => {
		if (closed) return false;
		let frame: string;
		try {
			frame = `${JSON.stringify(value)}\n`;
		} catch {
			return false;
		}
		// No await or user-controlled serialization between authorization and transport.
		beforeSend?.();
		if (closed) return false;
		try {
			input.write(frame);
			return true;
		} catch {
			return false;
		}
	};

	const shutdown = (error: Error, eof: boolean): void => {
		const already = closed;
		closed = true;
		if (!already) {
			if (eof) emit("eof", { message: error.message });
			failPending(error);
		}
		output.off("data", onData);
	};

	const handle = (raw: unknown): void => {
		if (!isRecord(raw)) return;
		const method = raw["method"];
		if (
			typeof method === "string" &&
			hasId(raw) &&
			!("result" in raw) &&
			!("error" in raw)
		) {
			void answer(raw.id, method, raw["params"]);
			return;
		}
		if (typeof method === "string" && !hasId(raw)) {
			emit(method, raw["params"]);
			return;
		}
		if (hasId(raw) && pending.has(raw.id)) {
			const item = pending.get(raw.id);
			pending.delete(raw.id);
			if (!item) return;
			clearTimeout(item.timer);
			item.abort?.();
			if ("error" in raw) {
				const error = raw["error"];
				if (
					!("result" in raw) &&
					!("method" in raw) &&
					isRecord(error) &&
					typeof error["code"] === "number" &&
					Number.isSafeInteger(error["code"]) &&
					typeof error["message"] === "string"
				)
					item.settle(new CodexRpcRemoteError(error["message"], error["code"]));
				else item.settle(new Error(errorMessage(error, "Codex RPC error")));
				return;
			}
			item.settle(undefined, raw["result"]);
			return;
		}
		if ("error" in raw && !hasId(raw)) emit("error", raw["error"]);
	};

	const answer = async (
		id: JsonRpcId,
		method: string,
		params: unknown,
	): Promise<void> => {
		const deliveryChecks: Array<() => void> = [];
		try {
			let handled = false;
			let result: unknown;
			for (const handler of requestHandlers) {
				const value = await handler(method, params, (check) =>
					deliveryChecks.push(check),
				);
				if (value !== undefined) {
					result = value;
					handled = true;
				}
			}
			if (!handled) {
				writeSafe({
					id,
					error: {
						code: METHOD_NOT_FOUND,
						message: `Unknown Codex request: ${method}`,
					},
				});
				return;
			}
			const resultCheck = responseDeliveryCheck(result);
			if (resultCheck) deliveryChecks.push(resultCheck);
			writeSafe({ id, result }, () => {
				for (const check of deliveryChecks) check();
			});
		} catch (error) {
			writeSafe({
				id,
				error: {
					code: INTERNAL_ERROR,
					message: deliveryChecks.length
						? "Codex request delivery blocked"
						: error instanceof Error
							? error.message
							: "Codex request failed",
				},
			});
		}
	};

	const onData = (chunk: Buffer | string): void => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		if (buffer.length > 16 * 1024 * 1024) {
			shutdown(Error("Codex RPC frame exceeded limit"), true);
			return;
		}
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim()) {
				try {
					handle(JSON.parse(line) as unknown);
				} catch {
					emit("error", {
						code: PARSE_ERROR,
						message: "Invalid Codex RPC line",
					});
				}
			}
			idx = buffer.indexOf("\n");
		}
	};

	output.on("data", onData);
	const onEnd = (): void => {
		shutdown(new Error("Codex RPC ended (EOF)"), true);
	};
	output.on("end", onEnd);
	output.on("close", onEnd);
	output.on("error", onEnd);
	input.on("error", onEnd);
	child?.on("exit", () => {
		shutdown(new Error("Codex RPC child exited"), true);
	});
	child?.on("error", (error) => {
		shutdown(
			error instanceof Error ? error : new Error("Codex RPC spawn failed"),
			true,
		);
	});

	return {
		get closed() {
			return closed;
		},
		get pid() {
			return child?.pid;
		},
		request<T>(
			method: string,
			params?: unknown,
			signal?: AbortSignal,
			beforeSend?: () => void,
		): Promise<T> {
			if (closed) return Promise.reject(new Error("Codex RPC is closed"));
			signal?.throwIfAborted();
			const id = nextId;
			nextId += 1;
			return new Promise<T>((resolve, reject) => {
				const settle = (error: Error | undefined, result?: unknown): void => {
					if (error) reject(error);
					else resolve(result as T);
				};
				const item: Pending = {
					settle,
					timer: setTimeout(() => {
						pending.delete(id);
						item.abort?.();
						settle(new Error(`Codex RPC timeout: ${method}`));
					}, timeoutMs),
					abort: undefined,
				};
				if (signal) {
					const onAbort = (): void => {
						pending.delete(id);
						clearTimeout(item.timer);
						settle(
							signal.reason instanceof Error
								? signal.reason
								: new Error("Codex RPC aborted"),
						);
					};
					signal.addEventListener("abort", onAbort, { once: true });
					item.abort = () => signal.removeEventListener("abort", onAbort);
				}
				pending.set(id, item);
				let failure: Error | undefined;
				try {
					if (
						!writeSafe(
							{
								id,
								method,
								...(params === undefined ? {} : { params }),
							},
							beforeSend,
						)
					)
						failure = new Error("Codex RPC write failed");
				} catch {
					failure = new Error("Codex request dispatch blocked");
				}
				if (failure) {
					pending.delete(id);
					clearTimeout(item.timer);
					item.abort?.();
					reject(failure);
				}
			});
		},
		notify(method: string, params?: unknown): void {
			if (!writeSafe({ method, ...(params === undefined ? {} : { params }) }))
				throw new Error("Codex RPC is closed");
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onRequest(handler) {
			requestHandlers.add(handler);
			return () => {
				requestHandlers.delete(handler);
			};
		},
		close() {
			if (closing) return closing;
			closing = (async () => {
				shutdown(new Error("Codex RPC is closed"), false);
				if (ownsProcess && child?.pid) {
					const pid = child.pid;
					const stop = (signal: NodeJS.Signals) => {
						try {
							if (process.platform !== "win32") process.kill(-pid, signal);
							else child?.kill(signal);
						} catch (error) {
							if (
								!(
									error &&
									typeof error === "object" &&
									"code" in error &&
									error.code === "ESRCH"
								)
							)
								throw error;
						}
					};
					let timer: ReturnType<typeof setTimeout> | undefined;
					const exited = new Promise<void>((resolve) => {
						if (child?.exitCode !== null || child?.signalCode !== null) {
							resolve();
							return;
						}
						child.once("exit", () => resolve());
					});
					stop("SIGTERM");
					await Promise.race([
						exited,
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, options.shutdownGraceMs ?? 3000);
						}),
					]);
					clearTimeout(timer);
					// The launcher may exit before its native child. The owned group includes both.
					stop("SIGKILL");
					await exited;
				} else input.end();
				listeners.clear();
				requestHandlers.clear();
			})();
			return closing;
		},
	};
}
