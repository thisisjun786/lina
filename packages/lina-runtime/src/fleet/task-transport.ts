import { randomUUID } from "node:crypto";
import type {
	TaskNotification,
	TaskRpc,
	TaskServerRequest,
} from "../../../lina-codex/src/task-rpc.ts";

const SUPPORTED_REQUESTS = new Set([
	"item/tool/call",
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);

type Rpc = {
	readonly closed: boolean;
	request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T>;
	notify(method: string, params?: unknown): void;
	subscribe(listener: (method: string, params: unknown) => void): () => void;
	onRequest(
		handler: (method: string, params: unknown) => Promise<unknown>,
	): () => void;
	close(): Promise<void>;
};

/** Owns a disposable proxy connection, never the shared Codex daemon. */
export function createTaskTransport(
	connect: () => Promise<Rpc>,
	acceptsRequest: (method: string, params: unknown) => boolean = () => true,
): TaskRpc & {
	subscribeRequests(listener: (request: TaskServerRequest) => void): () => void;
	respond(id: string | number, result: unknown): Promise<void>;
	close(): Promise<void>;
} {
	let active: Rpc | undefined;
	let connecting: Promise<Rpc> | undefined;
	let closed = false;
	const notifications = new Set<(event: TaskNotification) => void>();
	const requests = new Set<(event: TaskServerRequest) => void>();
	const approvals = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	let detach: (() => void)[] = [];
	const clear = () => {
		for (const off of detach.splice(0)) off();
		for (const item of approvals.values())
			item.reject(Error("Codex proxy disconnected"));
		approvals.clear();
	};
	const ensure = (): Promise<Rpc> => {
		if (closed) return Promise.reject(Error("Codex task transport is closed"));
		if (active && !active.closed) return Promise.resolve(active);
		if (connecting) return connecting;
		clear();
		connecting = (async () => {
			const rpc = await connect();
			try {
				await rpc.request("initialize", {
					clientInfo: { name: "lina-tasks", version: "1.0.0" },
					capabilities: { experimentalApi: true },
				});
				rpc.notify("initialized");
				if (closed) throw Error("Codex task transport is closed");
				detach = [
					rpc.subscribe((method, params) => {
						for (const listener of notifications) listener({ method, params });
						if (method === "eof") clear();
					}),
					rpc.onRequest(async (method, params) => {
						if (!SUPPORTED_REQUESTS.has(method))
							throw Error(
								"Unsupported Codex task request; answer in the native client if available",
							);
						if (closed || !requests.size || !acceptsRequest(method, params))
							throw Error("No LINA task approval receiver");
						const id = randomUUID();
						return new Promise<unknown>((resolve, reject) => {
							approvals.set(id, { resolve, reject });
							try {
								for (const listener of requests)
									listener({ id, method, params });
							} catch (error) {
								approvals.delete(id);
								reject(error);
							}
						});
					}),
				];
				active = rpc;
				return rpc;
			} catch (error) {
				await rpc.close();
				throw error;
			}
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	};
	return {
		async request<T>(method: string, params?: unknown, signal?: AbortSignal) {
			signal?.throwIfAborted();
			const rpc = await ensure();
			signal?.throwIfAborted();
			return rpc.request<T>(method, params, signal);
		},
		subscribe(listener) {
			notifications.add(listener);
			return () => {
				notifications.delete(listener);
			};
		},
		subscribeRequests(listener) {
			requests.add(listener);
			return () => {
				requests.delete(listener);
			};
		},
		async respond(id, result) {
			const pending = approvals.get(String(id));
			if (!pending) throw Error("Unknown or disconnected Codex approval");
			approvals.delete(String(id));
			pending.resolve(result);
		},
		async close() {
			if (closed) return;
			closed = true;
			clear();
			await connecting?.catch(() => undefined);
			await active?.close();
			notifications.clear();
			requests.clear();
		},
	};
}
