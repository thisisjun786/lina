import { describe, expect, it } from "bun:test";
import { DiscordAuthError } from "../src/discord/rest.ts";
import { main } from "../src/discord-bridge.ts";
import { config, message } from "./discord-bridge-fixtures.ts";
import { harness, started } from "./discord-bridge-harness.ts";

describe("Discord bridge delivery", () => {
	it("posts the collected turn as a reply when a gateway message is connected", async () => {
		// Given
		const h = await started(harness({ realPipeline: true }));
		h.emitConnected();
		h.emitGateway([message("7")]);
		await h.runtime.settled();

		// When
		h.emitStatus("idle");
		h.emitStatus("running");
		h.emitText("reply");
		h.emitStatus("idle");
		await h.runtime.settled();

		// Then
		expect(h.calls).toContain("inject:7");
		expect(h.calls).toContain("send:7:reply");
		expect(h.logs).toContain("[discord-bridge] posted reply 800");
	});

	it("exits with code 1 when Discord authentication answers 401", async () => {
		// Given
		const h = harness({
			authError: new DiscordAuthError(
				"GET /users/@me",
				"secret-token rejected",
			),
		});
		const exits: number[] = [];
		const stderr: unknown[] = [];

		// When
		await main({
			env: {
				DISCORD_BOT_TOKEN: config.token,
				DISCORD_CHANNEL_ID: config.channelId,
				LINA_DISCORD_ALLOWED_USER_IDS: "42",
				LINA_DISCORD_CATCHUP_MS: "5000",
				LINA_DISCORD_REST_API: config.restApi,
			},
			dependencies: () => h.deps,
			exit: (code) => {
				exits.push(code);
			},
			stderr: (value) => {
				stderr.push(value);
			},
		});

		// Then
		expect(exits).toEqual([1]);
		expect(stderr).toEqual([
			"[discord-bridge] fatal: invalid DISCORD_BOT_TOKEN",
		]);
		expect(h.calls).toEqual([]);
	});

	it("admits one message when gateway and catch-up both deliver it", async () => {
		// Given
		const h = await started();
		h.emitConnected();
		h.setCatchup([message("7")]);
		h.emitReady();

		// When
		h.emitGateway([message("7")]);
		await h.runtime.settled();

		// Then
		expect(h.calls.filter((call) => call === "admitted:7")).toHaveLength(1);
	});

	it("drains catch-up first when a newer gateway batch races it", async () => {
		// Given
		const h = await started();
		h.setCatchup([message("6")]);
		h.emitConnected();

		// When
		h.emitGateway([message("9")]);
		await h.runtime.settled();

		// Then
		expect(h.calls.filter((call) => call.startsWith("offer:"))).toEqual([
			"offer:catchup:6",
			"offer:gateway:9",
		]);
	});

	it("logs both failures when offer and drain reject", async () => {
		// Given
		const h = await started();
		h.emitConnected();
		await h.runtime.settled();

		// When
		h.setOfferError(new Error("corrupt cursor"));
		h.emitGateway([message("7")]);
		await h.runtime.settled();
		h.setOfferError(undefined);
		h.setDrainError(new Error("cursor write"));
		h.emitGateway([message("8")]);
		await h.runtime.settled();

		// Then
		expect(
			h.logs.filter((line) => line.includes("delivery failed")),
		).toHaveLength(2);
	});

	it("contains the rejection when reply posting fails", async () => {
		// Given
		const h = harness();
		h.setSenderError(new Error("send hung then failed"));
		const running = await started(h);
		await running.deps.interventionClient.send({
			type: "chat",
			id: "7",
			text: "x",
		});

		// When
		running.emitTurn("reply");
		await running.runtime.settled();
		await running.runtime.stop();

		// Then
		expect(
			running.logs.some((line) => line.includes("reply failed")),
		).toBeTrue();
	});

	it("logs turn-empty and posts nothing when a collected turn is empty", async () => {
		// Given
		const h = await started(harness({ realPipeline: true }));
		h.emitConnected();
		h.emitGateway([message("7")]);
		await h.runtime.settled();
		const sendsBeforeTurn = h.calls.filter((call) => call.startsWith("send:"));

		// When
		h.emitStatus("idle");
		h.emitStatus("running");
		h.emitText("  \n\t");
		h.emitStatus("idle");
		await h.runtime.settled();

		// Then
		expect(h.logs).toContain("turn-empty");
		expect(h.calls.filter((call) => call.startsWith("send:"))).toEqual(
			sendsBeforeTurn,
		);
	});

	it("logs no posted reply when the sender produces no message IDs", async () => {
		// Given
		const h = await started(harness({ senderMessageIds: [] }));
		await h.deps.interventionClient.send({ type: "chat", id: "7", text: "x" });

		// When
		h.emitTurn("reply");
		await h.runtime.settled();

		// Then
		expect(h.calls).toContain("send:7:reply");
		expect(h.logs.some((line) => line.includes("posted reply"))).toBeFalse();
	});
});
