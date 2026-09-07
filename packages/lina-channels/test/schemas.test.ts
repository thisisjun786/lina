import { describe, expect, it } from "bun:test";
import {
	AllowedIdsSchema,
	DiscordMessageSchema,
	parseBridgeConfig,
	SnowflakeSchema,
} from "../src/discord/schemas.ts";

const validEnvironment = {
	DISCORD_BOT_TOKEN: "token",
	DISCORD_CHANNEL_ID: "123",
	LINA_DISCORD_ALLOWED_USER_IDS: "1, 2",
};

const validMessage = {
	id: "123",
	channel_id: "456",
	author: { id: "789" },
	content: "hello",
	timestamp: "2026-09-04T12:00:00+00:00",
};

describe("Discord boundary schemas", () => {
	it("parses a valid message subset when the payload is valid", () => {
		expect(DiscordMessageSchema.parse(validMessage).content).toBe("hello");
	});

	it("rejects malformed snowflakes when the value is invalid", () => {
		expect(SnowflakeSchema.safeParse("abc").success).toBe(false);
		expect(SnowflakeSchema.safeParse("0").success).toBe(false);
		expect(SnowflakeSchema.safeParse("1".repeat(21)).success).toBe(false);
	});

	it("rejects a timestamp when the offset is missing", () => {
		expect(
			DiscordMessageSchema.safeParse({
				...validMessage,
				timestamp: "2026-09-04T12:00:00",
			}).success,
		).toBe(false);
	});

	it("parses an empty allowlist when no ids are provided", () => {
		expect(AllowedIdsSchema.parse("")).toEqual([]);
	});

	it("rejects duplicate allowlist ids when an id repeats", () => {
		expect(AllowedIdsSchema.safeParse("1,1").success).toBe(false);
	});

	it("rejects a poll interval when it is below the minimum", () => {
		expect(
			parseBridgeConfig({ ...validEnvironment, LINA_DISCORD_CATCHUP_MS: "100" })
				.kind,
		).toBe("error");
	});

	it("rejects an intervention URL when it uses HTTP", () => {
		expect(
			parseBridgeConfig({
				...validEnvironment,
				LINA_INTERVENTION_URL: "http://x",
			}).kind,
		).toBe("error");
	});

	it("returns an error when the token is missing", () => {
		const result = parseBridgeConfig({ DISCORD_CHANNEL_ID: "123" });
		expect(result.kind).toBe("error");
	});

	it("parses a valid bridge config when defaults apply", () => {
		const result = parseBridgeConfig(validEnvironment);
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.config.catchupMs).toBe(60000);
	});

	it("rejects an empty token when the token is blank", () => {
		expect(
			parseBridgeConfig({ ...validEnvironment, DISCORD_BOT_TOKEN: "" }).kind,
		).toBe("error");
	});
});
