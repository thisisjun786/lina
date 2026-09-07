import { describe, expect, it } from "bun:test";
import {
	createGatewaySource,
	type GatewayClientLike,
	type GatewayEventName,
	MISSING_CONTENT_LOG,
} from "../src/discord/gateway-source.ts";
import type { DiscordMessage } from "../src/discord/schemas.ts";

const CHANNEL_ID = "555";
const TOKEN = "bot-token";
const CREATED_AT = new Date("2026-09-04T12:00:00.000Z");

type Handler = (...args: readonly unknown[]) => void;

/** Stands in for discord.js Client: the same five events, no socket. */
class FakeGatewayClient implements GatewayClientLike {
	private readonly handlers = new Map<GatewayEventName, Handler[]>();
	user: { readonly id: string } | null = null;
	loginError: Error | undefined = undefined;
	logins = 0;
	destroys = 0;

	on(event: GatewayEventName, handler: Handler): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}
	login(): Promise<unknown> {
		this.logins += 1;
		return this.loginError === undefined
			? Promise.resolve("logged-in")
			: Promise.reject(this.loginError);
	}
	destroy(): void {
		this.destroys += 1;
	}
	/** A freshly built Client carries no listeners; rebuilding must mirror that. */
	rebuild(): void {
		this.handlers.clear();
	}
	emit(event: GatewayEventName, ...args: readonly unknown[]): void {
		for (const handler of this.handlers.get(event) ?? []) handler(...args);
	}
}

function gatewayMessage(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "9001",
		channelId: CHANNEL_ID,
		author: { id: "42", bot: false },
		content: "hello",
		createdAt: CREATED_AT,
		...overrides,
	};
}

function setup(gateway: "on" | "off" = "on") {
	const client = new FakeGatewayClient();
	const delivered: DiscordMessage[][] = [];
	const readyIds: string[] = [];
	const shardEvents: string[] = [];
	const logs: string[] = [];
	let builds = 0;
	const built = (): number => builds;
	const source = createGatewaySource({
		token: TOKEN,
		channelId: CHANNEL_ID,
		gateway,
		clientFactory: () => {
			builds += 1;
			client.rebuild();
			return client;
		},
		log: (message) => logs.push(message),
	});
	source.onMessages((messages) => delivered.push([...messages]));
	source.onReady((ready) => readyIds.push(ready.botUserId));
	source.onDisconnect(() => shardEvents.push("disconnect"));
	source.onResume(() => shardEvents.push("resume"));
	return { client, source, delivered, readyIds, shardEvents, logs, built };
}

async function started(gateway: "on" | "off" = "on") {
	const harness = setup(gateway);
	await harness.source.start();
	return harness;
}

describe("Discord gateway source", () => {
	it("emits the bot user id when ready fires", async () => {
		const h = await started();
		h.client.user = { id: "bot-7" };
		h.client.emit("ready");
		expect(h.readyIds).toEqual(["bot-7"]);
		expect(h.client.logins).toBe(1);
	});
	it("emits ready once when the client fires both ready and clientReady", async () => {
		const h = await started();
		h.client.user = { id: "bot-7" };
		h.client.emit("ready");
		h.client.emit("clientReady");
		expect(h.readyIds).toEqual(["bot-7"]);
	});
	it("emits ready again when the shard reconnects after a disconnect", async () => {
		const h = await started();
		h.client.user = { id: "bot-7" };
		h.client.emit("clientReady");
		h.client.emit("shardDisconnect");
		h.client.emit("clientReady");
		expect(h.readyIds).toEqual(["bot-7", "bot-7"]);
	});
	it("publishes ready again when the source is restarted after a stop", async () => {
		const h = await started();
		h.client.user = { id: "bot-7" };
		h.client.emit("clientReady");
		await h.source.stop();
		await h.source.start();
		h.client.emit("clientReady");
		expect(h.readyIds).toEqual(["bot-7", "bot-7"]);
		expect(h.built()).toBe(2);
	});
	it("emits no ready when the client carries no bot user yet", async () => {
		const h = await started();
		h.client.emit("ready");
		expect(h.readyIds).toEqual([]);
		expect(h.logs).toEqual(["ready fired without a bot user id"]);
	});

	it("maps a messageCreate to a DiscordMessage when it targets the configured channel", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage());
		expect(h.delivered[0]?.[0]).toEqual({
			id: "9001",
			channel_id: CHANNEL_ID,
			author: { id: "42", bot: false },
			content: "hello",
			timestamp: "2026-09-04T12:00:00.000Z",
		});
		expect(h.delivered).toHaveLength(1);
	});
	it("delivers an attachment-only message when its content is an empty string", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage({ content: "" }));
		expect(h.delivered[0]?.[0]?.content).toBe("");
		expect(h.logs).toEqual([]);
	});
	it("ignores a messageCreate when it targets another channel", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage({ channelId: "999" }));
		expect(h.delivered).toEqual([]);
		expect(h.logs).toEqual([]);
	});

	it("names the Message Content Intent and emits nothing when content is missing", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage({ content: undefined }));
		expect(h.delivered).toEqual([]);
		expect(h.logs).toEqual([MISSING_CONTENT_LOG]);
		// The one fragment an operator acts on: the Developer Portal switch name.
		expect(h.logs[0]).toContain("Message Content Intent");
	});
	it("names the Message Content Intent and emits nothing when content is null", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage({ content: null }));
		expect(h.delivered).toEqual([]);
		expect(h.logs).toEqual([MISSING_CONTENT_LOG]);
		expect(h.logs[0]).toContain("Message Content Intent");
	});
	it("keeps another channel silent when its content is missing too", async () => {
		const h = await started();
		const foreign = gatewayMessage({ channelId: "999", content: null });
		h.client.emit("messageCreate", foreign);
		expect(h.logs).toEqual([]);
	});

	it("logs the failing fields only when a messageCreate payload is malformed", async () => {
		const h = await started();
		h.client.emit("messageCreate", { id: 12, author: null, content: "secret" });
		expect(h.delivered).toEqual([]);
		expect(h.logs).toEqual([
			"ignored a malformed gateway message: id, channelId, author, createdAt",
		]);
	});
	it("rejects a messageCreate when its id is not a snowflake", async () => {
		const h = await started();
		h.client.emit("messageCreate", gatewayMessage({ id: "0" }));
		expect(h.delivered).toEqual([]);
		expect(h.logs).toEqual([
			"ignored a gateway message failing the Discord schema: id",
		]);
	});
	it("emits disconnect then resume when the shard drops and resumes", async () => {
		const h = await started();
		h.client.emit("shardDisconnect");
		h.client.emit("shardResume");
		expect(h.shardEvents).toEqual(["disconnect", "resume"]);
	});
	it("redacts the token when the client emits an error carrying it", async () => {
		const h = await started();
		h.client.emit("error", new Error(`connect failed for ${TOKEN}`));
		expect(h.logs).toEqual(["gateway error: connect failed for <redacted>"]);
	});

	it("never constructs a client when the gateway is off", async () => {
		const h = await started("off");
		expect(h.built()).toBe(0);
		expect(h.source.state()).toBe("disabled");
		expect(h.client.logins).toBe(0);
		expect(h.logs).toEqual(["gateway disabled"]);
	});
	it("destroys the client and reports stopped when stop is called", async () => {
		const h = await started();
		expect(h.source.state()).toBe("running");
		await h.source.stop();
		expect(h.client.destroys).toBe(1);
		expect(h.source.state()).toBe("stopped");
	});

	it("builds and logs in one client only when start is called twice", async () => {
		const h = await started();
		await h.source.start();
		expect(h.built()).toBe(1);
		expect(h.client.logins).toBe(1);
	});

	it("reports stopped and destroys the client when login fails", async () => {
		const h = setup();
		h.client.loginError = new Error("invalid token");
		await expect(h.source.start()).rejects.toThrow("invalid token");
		expect(h.source.state()).toBe("stopped");
		expect(h.client.destroys).toBe(1);
	});
	it("builds a fresh client when start is retried after a failed login", async () => {
		const h = setup();
		h.client.loginError = new Error("invalid token");
		await h.source.start().catch(() => undefined);
		h.client.loginError = undefined;
		await h.source.start();
		expect(h.built()).toBe(2);
		expect(h.source.state()).toBe("running");
		h.client.user = { id: "bot-7" };
		h.client.emit("clientReady");
		expect(h.readyIds).toEqual(["bot-7"]);
	});
});
