import { expect, test } from "bun:test";
import { lifeRoutes } from "../src/fleet/life-routes.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("installed fleet serves owner-only status, manual step and durable private detail without an ordinary chat", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup();
		const base = `http://127.0.0.1:${f.app.port}/api/life/worlds/test-world`;
		const status = await fetch(`${base}/status`);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ status: "ready" });
		const post = () =>
			fetch(`${base}/step`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					idempotencyKey: "owner-step",
					expectedConfigRevision: 1,
				}),
			});
		const first = await post();
		expect(first.status).toBe(200);
		const step = (await first.json()) as { id: string; status: string };
		expect(step.status).toBe("accepted");
		expect(await (await post()).json()).toEqual(step);
		expect(await (await fetch(`${base}/steps/${step.id}`)).json()).toEqual(
			step,
		);
		expect(f.app.fleet.opened("lina")).toBeUndefined();
		expect(f.models).toHaveLength(1);
		expect(f.models[0]?.requests).toHaveLength(0);
		expect(f.providerCalls).toBe(0);
		await f.restart();
		const detail = await fetch(
			`http://127.0.0.1:${f.app.port}/api/life/worlds/test-world/steps/${step.id}`,
		);
		expect(await detail.json()).toEqual(step);
	} finally {
		await f.close();
	}
});

test("runtime routes reject origin, foreign host, method, query and unknown input before dispatch", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup();
		const base = `http://127.0.0.1:${f.app.port}/api/life/worlds/test-world`;
		for (const headers of [
			{ origin: "http://127.0.0.1" },
			{ host: "evil.invalid" },
		])
			expect((await fetch(`${base}/status`, { headers })).status).toBe(403);
		for (const url of [
			"http://localhost:9/api/life/worlds/test-world/status",
			"https://127.0.0.1:9/api/life/worlds/test-world/status",
		])
			expect(
				(
					await lifeRoutes(
						new Request(url, { headers: { host: new URL(url).host } }),
						f.app.fleet,
						async () => ({}),
					)
				)?.status,
			).toBe(403);
		expect((await fetch(`${base}/status?hidden=true`)).status).toBe(400);
		expect((await fetch(`${base}/status`, { method: "POST" })).status).toBe(
			405,
		);
		for (const body of [
			{ idempotencyKey: "bad", expectedConfigRevision: 1, source: {} },
			{ idempotencyKey: "bad", expectedConfigRevision: "1" },
		])
			expect(
				(
					await fetch(`${base}/step`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		expect(f.models[0]?.requests).toHaveLength(0);
	} finally {
		await f.close();
	}
});
