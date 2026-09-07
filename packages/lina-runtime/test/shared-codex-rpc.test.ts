import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedCodexRpc } from "../src/fleet/shared-codex-rpc.ts";

const { WebSocketServer } = (await import(
	new URL("./wrapper.mjs", import.meta.resolve("ws/package.json")).href
)) as typeof import("ws");
test("shared Codex uses WebSocket upgrade over owned Unix socket and closes only its connection", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-ws-unix-"));
	const socket = join(root, "control.sock");
	const server = createServer();
	const ws = new WebSocketServer({ server, perMessageDeflate: false });
	ws.on("connection", (peer) =>
		peer.on("message", (data) => {
			const req = JSON.parse(data.toString());
			peer.send(JSON.stringify({ id: req.id, result: { echo: req.params } }));
		}),
	);
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	chmodSync(socket, 0o600);
	try {
		const client = await createSharedCodexRpc(socket);
		expect(await client.request<unknown>("echo", { text: "한글" })).toEqual({
			echo: { text: "한글" },
		});
		await client.close();
		expect(server.listening).toBe(true);
		const again = await createSharedCodexRpc(socket);
		expect(await again.request<unknown>("echo", {})).toEqual({ echo: {} });
		await again.close();
	} finally {
		for (const peer of ws.clients) peer.terminate();
		await new Promise<void>((resolve) => ws.close(() => resolve()));
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
