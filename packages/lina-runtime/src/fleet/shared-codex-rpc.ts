import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { type CodexRpc, createCodexRpc } from "../../../lina-codex/src/rpc.ts";

/** Codex's control UDS speaks WebSocket, whereas app-server stdio speaks JSONL. */
export async function createSharedCodexRpc(
	socketPath: string,
): Promise<CodexRpc> {
	const stat = lstatSync(socketPath);
	if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
		throw Error("Codex control socket must belong to the current user");
	// Bun's built-in `ws` replacement does not implement createConnection/Unix sockets.
	// Load the installed, pinned ws implementation directly instead.
	const { default: WebSocket } = (await import(
		new URL("./wrapper.mjs", import.meta.resolve("ws/package.json")).href
	)) as { default: typeof import("ws").WebSocket };
	const socket = new WebSocket("ws://localhost/", {
		createConnection: () => connect(socketPath),
		perMessageDeflate: false,
		handshakeTimeout: 10000,
		maxPayload: 16 * 1024 * 1024,
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const output = new PassThrough();
	let buffer = "";
	const input = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			try {
				for (const line of lines) if (line.trim()) socket.send(line);
				callback();
			} catch (error) {
				callback(
					error instanceof Error ? error : Error("Codex socket write failed"),
				);
			}
		},
		final(callback) {
			socket.close();
			callback();
		},
	});
	socket.on("message", (data) => {
		output.write(`${data.toString()}\n`);
	});
	socket.on("close", () => output.end());
	socket.on("error", (error) => output.destroy(error));
	const rpc = await createCodexRpc({
		stdio: { input, output },
		ownsProcess: false,
	});
	const closeRpc = rpc.close.bind(rpc);
	let closing: Promise<void> | undefined;
	rpc.close = () => {
		if (closing) return closing;
		closing = (async () => {
			await closeRpc();
			socket.terminate();
			input.destroy();
			output.destroy();
		})();
		return closing;
	};
	return rpc;
}
