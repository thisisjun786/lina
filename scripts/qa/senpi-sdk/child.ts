import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
	bounded,
	type Command,
	packetSchema,
	snapshotSchema,
} from "./protocol.ts";

export function startChild(root: string, endpoint: string, file = "") {
	const bus = new EventEmitter();
	const wait = (kind: string) =>
		bounded(
			new Promise<unknown>((resolve, reject) => {
				const receive = (data: unknown) => {
					cleanup();
					resolve(data);
				};
				const fail = (error: unknown) => {
					cleanup();
					reject(error);
				};
				const cleanup = () => {
					bus.off(kind, receive);
					bus.off("failed", fail);
				};
				bus.once(kind, receive);
				bus.once("failed", fail);
			}),
			`worker ${kind}`,
		);
	const ready = wait("ready").then((value) => snapshotSchema.parse(value));
	const worker = import.meta.path.endsWith(".js") ? "worker.js" : "worker.ts";
	const child = spawn(
		process.execPath,
		["--no-env-file", join(import.meta.dir, worker), root, endpoint, file],
		{
			cwd: join(root, "workspace"),
			// Deliberate allowlist: no ambient credentials, proxies, plugin paths, or user state.
			env: {
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "home", "config"),
				XDG_CACHE_HOME: join(root, "home", "cache"),
				XDG_DATA_HOME: join(root, "home", "data"),
				TMPDIR: join(root, "tmp"),
				SENPI_CODING_AGENT_DIR: join(root, "agent"),
				PI_CODING_AGENT_DIR: join(root, "agent"),
				OFFLINE: "1",
				DO_NOT_TRACK: "1",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	if (!child.stdout || !child.stderr)
		throw new Error("Worker pipes unavailable");
	child.stdout.on("data", (data: Buffer) =>
		appendFileSync(join(root, "worker.stdout"), data),
	);
	child.stderr.on("data", (data: Buffer) =>
		appendFileSync(join(root, "worker.stderr"), data),
	);
	child.on("message", (raw: unknown) => {
		const packet = packetSchema.safeParse(raw);
		if (!packet.success) {
			bus.emit("failed", packet.error);
			return;
		}
		if (packet.data.kind === "error") {
			bus.emit("failed", new Error(String(packet.data.data)));
			return;
		}
		bus.emit(packet.data.kind, packet.data.data);
	});
	child.on("error", (error) => bus.emit("failed", error));
	const exited = new Promise<{ code: number | null; signal: string | null }>(
		(resolve) => {
			child.once("exit", (code, signal) => {
				resolve({ code, signal });
				bus.emit(
					"failed",
					new Error(
						`Worker exited: ${code}/${signal}; see ${root}/worker.stderr`,
					),
				);
			});
		},
	);
	function send(command: Command) {
		child.send(command);
	}
	return {
		ready,
		exited,
		wait,
		send,
		async prompt(text: string) {
			const done = wait("done");
			send({ kind: "prompt", text });
			return snapshotSchema.parse(await done);
		},
		async close() {
			send({ kind: "close" });
			const exit = await bounded(exited, "worker exit");
			if (exit.code !== 0)
				throw new Error(`Worker failed: ${JSON.stringify(exit)}`);
		},
		async kill() {
			child.kill("SIGKILL");
			return bounded(exited, "worker kill");
		},
	};
}
