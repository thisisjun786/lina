import { describe, expect, it } from "bun:test";
import WebSocket from "ws";
import { activate } from "../src/activate.ts";
import { fakeHost } from "./fake-host.ts";

/** Opens a viewer and reads its connect-time snapshot; the listener is attached before the socket opens. */
async function firstFrame(port: number): Promise<unknown> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const frame = await new Promise<unknown>((resolve, reject) => {
		ws.once("message", (data) => resolve(JSON.parse(data.toString())));
		ws.once("error", reject);
	});
	ws.close();
	return frame;
}

describe("activate", () => {
	it("registers every lina_* tool and opens the intervention server when the host boots", async () => {
		const host = fakeHost();
		const lina = await activate(host.api, {
			interventionPort: 0,
			idleTimeoutMs: 0,
			dataDir: "/tmp/lina-test-data",
		});
		expect(host.registered).toEqual([
			"lina_notepad_read",
			"lina_notepad_append",
			"lina_status",
		]);
		expect(lina.interventionPort).toBeGreaterThan(0);
		await lina.stop();
	});

	it("reports running when agent_start fires", async () => {
		const host = fakeHost();
		const lina = await activate(host.api, {
			interventionPort: 0,
			idleTimeoutMs: 0,
			dataDir: "/tmp/lina-test-data",
		});
		host.emit("agent_start");
		expect(await firstFrame(lina.interventionPort)).toEqual({
			type: "agent-status",
			state: "running",
		});
		await lina.stop();
	});

	it("reports idle again when agent_end fires", async () => {
		const host = fakeHost();
		const lina = await activate(host.api, {
			interventionPort: 0,
			idleTimeoutMs: 0,
			dataDir: "/tmp/lina-test-data",
		});
		host.emit("agent_start");
		host.emit("agent_end");
		expect(await firstFrame(lina.interventionPort)).toEqual({
			type: "agent-status",
			state: "idle",
		});
		await lina.stop();
	});
});
