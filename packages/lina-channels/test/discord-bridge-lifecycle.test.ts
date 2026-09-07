import { describe, expect, it } from "bun:test";
import { message } from "./discord-bridge-fixtures.ts";
import { harness, started } from "./discord-bridge-harness.ts";

describe("Discord bridge lifecycle", () => {
	it("pauses catch-up and the queue when intervention disconnects", async () => {
		// Given
		const h = await started();
		h.emitConnected();

		// When
		h.emitDisconnected();
		await h.runtime.settled();

		// Then
		expect(h.calls.filter((call) => call === "queue.pause")).toHaveLength(2);
		expect(h.calls.filter((call) => call === "catchup.pause")).toHaveLength(2);
		expect(h.calls.filter((call) => call === "collector.close")).toHaveLength(
			1,
		);
	});

	it("runs catch-up once when the gateway resumes", async () => {
		// Given
		const h = await started();

		// When
		h.emitResume();
		await h.runtime.settled();

		// Then
		expect(h.calls).toContain("catchup.run");
	});

	it("closes the collector once when disconnect repeats", async () => {
		// Given
		const h = await started();
		h.emitConnected();

		// When
		h.emitDisconnected();
		h.emitDisconnected();
		await h.runtime.settled();

		// Then
		expect(h.calls.filter((call) => call === "collector.close")).toHaveLength(
			1,
		);
	});

	it("stops without awaiting work when catch-up and sender hang", async () => {
		// Given
		const h = harness();
		const never = new Promise<void>(() => {});
		h.setCatchupWait(never);
		h.setSenderWait(never);
		const running = await started(h);
		running.emitConnected();
		await running.deps.interventionClient.send({
			type: "chat",
			id: "7",
			text: "x",
		});
		running.emitTurn("reply");

		// When
		await running.runtime.stop();

		// Then
		expect(running.calls).toContain("gateway.stop");
		expect(running.calls).toContain("intervention.close");
	});

	it("does not start queued delivery when stop fences catch-up", async () => {
		// Given
		const h = harness();
		const release = Promise.withResolvers<void>();
		h.setCatchupWait(release.promise);
		const running = await started(h);
		running.emitConnected();
		await running.catchupStarted;
		running.emitGateway([message("7")]);

		// When
		const stopping = running.runtime.stop();
		release.resolve();
		await stopping;
		await running.runtime.settled();

		// Then
		expect(
			running.calls.some((call) => call === "offer:gateway:7"),
		).toBeFalse();
	});

	it("does no work when retained callbacks fire after stop", async () => {
		// Given
		const h = await started();
		await h.runtime.stop();
		await h.runtime.stop();
		const calls = [...h.calls];
		const logs = [...h.logs];

		// When
		h.emitGateway([message("7")]);
		h.emitReady();
		h.emitResume();
		h.emitGatewayDisconnect();
		h.emitConnected();
		h.emitDisconnected();
		h.emitStatus("running");
		h.emitText("late");
		await h.runtime.settled();

		// Then
		expect(h.calls).toEqual(calls);
		expect(h.logs).toEqual(logs);
	});

	it("logs redacted cleanup errors when startup rejects", async () => {
		// Given
		const startError = new Error("gateway login failed");
		const h = harness({
			startError,
			stopError: new Error("cleanup secret-token"),
		});

		// When
		const outcome = await started(h).then(
			() => undefined,
			(error: unknown) => error,
		);

		// Then
		expect(outcome).toBe(startError);
		expect(h.logs).toEqual([
			"[discord-bridge] cleanup failed: cleanup <redacted>",
		]);
	});

	it("completes cleanup and preserves the error when startup rejects", async () => {
		// Given
		const startError = new Error("gateway login failed");
		const h = harness({ startError });

		// When
		const outcome = await started(h).then(
			() => undefined,
			(error: unknown) => error,
		);

		// Then
		expect(outcome).toBe(startError);
		expect(
			h.calls.filter((call) =>
				[
					"queue.pause",
					"catchup.pause",
					"catchup.stop",
					"intervention.close",
					"collector.close",
					"gateway.stop",
				].includes(call),
			),
		).toEqual([
			"queue.pause",
			"catchup.pause",
			"queue.pause",
			"catchup.pause",
			"catchup.stop",
			"intervention.close",
			"collector.close",
			"gateway.stop",
		]);
		const calls = [...h.calls];
		const logs = [...h.logs];
		h.emitGateway([message("7")]);
		h.emitReady();
		h.emitResume();
		h.emitGatewayDisconnect();
		h.emitConnected();
		h.emitDisconnected();
		expect(h.calls).toEqual(calls);
		expect(h.logs).toEqual(logs);
	});
});
