import { expect, spyOn, test } from "bun:test";
import { FleetResources } from "../src/fleet/resource-runtime.ts";
import { ResourceActivityDeliveryError } from "../src/life/resource-bridge.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("per-item delivery failure is visible without halting unrelated LIFE and clears after recovery", async () => {
	let failure: Error | null = new ResourceActivityDeliveryError([
		Error("category unavailable"),
	]);
	const original = FleetResources.prototype.activityBridge;
	const spy = spyOn(
		FleetResources.prototype,
		"activityBridge",
	).mockImplementation(function (this: FleetResources, world) {
		const bridge = original.call(this, world);
		return {
			...bridge,
			poll: (worldId: string) => {
				if (failure) throw failure;
				return bridge.poll(worldId);
			},
		};
	});
	const f = await fleetLifeFixture();
	try {
		f.setup();
		const runtime = f.app.fleet.lifeRuntime;
		const step = await runtime.run(
			"test-world",
			"unrelated",
			1,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		expect(runtime.status("test-world").activityDeliveryError).toBe(
			"activity_delivery_failed",
		);
		failure = null;
		const next = await runtime.run(
			"test-world",
			"recovered",
			1,
			new AbortController().signal,
		);
		expect(next.status).toBe("accepted");
		expect(runtime.status("test-world").activityDeliveryError).toBeNull();
		failure = Error("Installation ownership lost");
		await expect(
			runtime.run("test-world", "lost-owner", 1, new AbortController().signal),
		).rejects.toThrow("Installation ownership lost");
	} finally {
		spy.mockRestore();
		await f.close();
	}
});
