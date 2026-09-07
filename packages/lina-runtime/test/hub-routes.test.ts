import { expect, test } from "bun:test";
import { hubRoutes } from "../src/fleet/hub-routes.ts";

const status = {
	configured: true,
	connected: true,
	guiUrl: "https://hub.example.ts.net:10100",
	error: null,
	modelCount: 2,
};
test("hub management returns sanitized status and rejects arbitrary config writes", async () => {
	let count = 0;
	const hub = {
		status: () => status,
		refresh: async () => {
			count++;
		},
	};
	const response = await hubRoutes(
		new Request("http://localhost/api/hub/status"),
		hub,
		async () => ({}),
	);
	expect(await response?.json()).toEqual(status);
	const bad = await hubRoutes(
		new Request("http://localhost/api/hub/refresh", { method: "POST" }),
		hub,
		async () => ({ apiKey: "secret" }),
	);
	expect(bad?.status).toBe(400);
	expect(count).toBe(0);
	const ok = await hubRoutes(
		new Request("http://localhost/api/hub/refresh", { method: "POST" }),
		hub,
		async () => ({}),
	);
	expect(ok?.status).toBe(200);
	expect(count).toBe(1);
});
test("hub upstream failure is reported without reflecting secret-bearing error", async () => {
	const response = await hubRoutes(
		new Request("http://localhost/api/hub/refresh", { method: "POST" }),
		{
			status: () => ({ ...status, connected: false, error: "연결 실패" }),
			refresh: async () => {
				throw Error("Authorization: Bearer private");
			},
		},
		async () => ({}),
	);
	expect(response?.status).toBe(502);
	expect(await response?.text()).not.toContain("private");
});
