import { expect, spyOn, test } from "bun:test";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("manual LIFE HTTP uses lane cancellation instead of the server idle deadline", async () => {
	const serve = Bun.serve;
	const observed: number[] = [];
	const restores: Array<() => void> = [];
	const intercepted = spyOn(Bun, "serve").mockImplementation((options) => {
		const server = serve(options);
		const timeout = server.timeout.bind(server);
		const spy = spyOn(server, "timeout").mockImplementation(
			(request, seconds) => {
				if (
					new URL(request.url).pathname === "/api/life/worlds/test-world/step"
				)
					observed.push(seconds);
				return timeout(request, seconds);
			},
		);
		restores.push(() => spy.mockRestore());
		return server;
	});
	let fixture: Awaited<ReturnType<typeof fleetLifeFixture>> | undefined;
	try {
		fixture = await fleetLifeFixture();
		fixture.setup();
		const response = await fetch(
			`http://127.0.0.1:${fixture.app.port}/api/life/worlds/test-world/step`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					idempotencyKey: "timeout-contract",
					expectedConfigRevision: 1,
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(observed).toEqual([0]);
	} finally {
		await fixture?.close();
		for (const restore of restores) restore();
		intercepted.mockRestore();
	}
});
