/**
 * User-run live QA for the Discord REST path.
 *
 * Gated: without DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID it prints
 * "skipped: DISCORD_BOT_TOKEN unset" and exits 0, having touched no network.
 * With them set it calls getMe, reads the latest channel message (warning when
 * its content arrives empty, the symptom of a disabled Message Content
 * Intent), posts a LINA_DISCORD_QA_PING_<uuid> sentinel, and asserts the ping
 * comes back via getMessagesAfter after the previous latest id. Set
 * LINA_DISCORD_REST_API to a loopback URL to aim it at a local fake; any
 * other override is refused so the token can never leave the machine by
 * misconfiguration.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	createDiscordRest,
	DiscordAuthError,
	type DiscordRest,
	type RestFetch,
	type RestScheduler,
} from "../../src/discord/rest.ts";
import { SnowflakeSchema } from "../../src/discord/schemas.ts";

const DEFAULT_API = "https://discord.com/api/v10";
const USER_AGENT = "LinaBot/qa-live";
const PING_PREFIX = "LINA_DISCORD_QA_PING_";

const EnvSchema = z.object({
	DISCORD_BOT_TOKEN: z.string().min(1).optional(),
	DISCORD_CHANNEL_ID: SnowflakeSchema.optional(),
	LINA_DISCORD_REST_API: z.string().min(1).optional(),
	LINA_QA_DEADLINE_MS: z.coerce.number().int().min(500).default(120_000),
});

type QaConfig = {
	readonly token: string;
	readonly channelId: string;
	readonly baseUrl: string;
	readonly deadlineMs: number;
};

function dropEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && value.trim() !== "") {
			clean[key] = value;
		}
	}
	return clean;
}

function isLoopback(raw: string): boolean {
	const parsed = z.url().safeParse(raw);
	if (!parsed.success) {
		return false;
	}
	const url = new URL(parsed.data);
	return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

/** Parses the boundary once; everything below works on typed values. */
function parseConfig(
	env: NodeJS.ProcessEnv,
):
	| { readonly kind: "skip" }
	| { readonly kind: "run"; readonly config: QaConfig } {
	const parsed = EnvSchema.safeParse(dropEmpty(env));
	if (!parsed.success) {
		// A malformed value is a hard misconfiguration, not a skip.
		throw new Error(z.prettifyError(parsed.error));
	}
	if (
		parsed.data.DISCORD_BOT_TOKEN === undefined ||
		parsed.data.DISCORD_CHANNEL_ID === undefined
	) {
		return { kind: "skip" };
	}
	const override = parsed.data.LINA_DISCORD_REST_API;
	if (
		override !== undefined &&
		override !== DEFAULT_API &&
		!isLoopback(override)
	) {
		throw new Error(
			"LINA_DISCORD_REST_API must be a loopback URL; refusing to send the bot token off-host",
		);
	}
	return {
		kind: "run",
		config: {
			token: parsed.data.DISCORD_BOT_TOKEN ?? "",
			channelId: parsed.data.DISCORD_CHANNEL_ID ?? "",
			baseUrl: override ?? DEFAULT_API,
			deadlineMs: parsed.data.LINA_QA_DEADLINE_MS,
		},
	};
}

const scheduler: RestScheduler = {
	delay: (ms, handler) => {
		const timer = setTimeout(handler, ms);
		return () => clearTimeout(timer);
	},
};

const liveFetch: RestFetch = (url, init) => fetch(url, init);

function redact(text: string, token: string): string {
	return token === "" ? text : text.split(token).join("<redacted>");
}

function printManualLoop(): void {
	console.log(`Manual loop QA (real Discord, two terminals):
  terminal 1 (Lina):   LINA_IDLE_NUDGE_MS=0 ./scripts/run-lina.sh --no-loop
  terminal 2 (bridge): ./scripts/run-channels.sh
  From an allowed account, post in the channel:
    Reply exactly: LINA_DISCORD_QA_OK_<unique word>
  Expect exactly one bot reply with that content, as a reply to your message.
  Then Ctrl+C terminal 2, post once more while it is down, and restart it:
    the new message is answered by catch-up and nothing repeats.`);
}

async function runQa(config: QaConfig): Promise<void> {
	const rest: DiscordRest = createDiscordRest({
		token: config.token,
		userAgent: USER_AGENT,
		fetch: liveFetch,
		scheduler,
		clock: { now: () => Date.now() },
		baseUrl: config.baseUrl,
	});
	const me = await rest.getMe();
	console.log(`LIVE_STEP me id=${me.id}`);

	const latest = await rest.getLatestMessage(config.channelId);
	if (latest === undefined) {
		console.log("LIVE_STEP latest id=none (empty channel)");
	} else {
		console.log(`LIVE_STEP latest id=${latest.id}`);
		if (latest.content === "") {
			console.log("WARN: content empty - enable Message Content Intent");
		}
	}

	const uuid = randomUUID();
	const ping = await rest.createMessage(config.channelId, {
		content: `${PING_PREFIX}${uuid}`,
		nonce: uuid,
	});
	const afterId = latest?.id ?? "0";
	const readBack = (
		await rest.getMessagesAfter(config.channelId, afterId, 100)
	).find((message) => message.id === ping.id);
	if (readBack === undefined || !readBack.content.startsWith(PING_PREFIX)) {
		throw new Error(
			`posted ping ${ping.id} not returned by getMessagesAfter(${afterId})`,
		);
	}
	console.log(`LIVE_STEP ping id=${ping.id} read back after ${afterId}`);
	if (rest.malformedMessageCount() > 0) {
		throw new Error(
			`discord returned ${rest.malformedMessageCount()} unparseable message(s)`,
		);
	}
	console.log("LIVE_OK me/latest/ping/readback passed");
	printManualLoop();
}

function fail(error: unknown, token: string): never {
	const name =
		error instanceof DiscordAuthError
			? "DiscordAuthError"
			: error instanceof Error
				? error.name
				: "Error";
	const message = error instanceof Error ? error.message : String(error);
	console.error(`LIVE_FAIL: ${name} ${redact(message, token)}`);
	process.exit(1);
}

async function run(config: QaConfig): Promise<void> {
	const deadline = setTimeout(() => {
		console.error(
			`LIVE_FAIL: Error deadline exceeded after ${config.deadlineMs}ms`,
		);
		process.exit(1);
	}, config.deadlineMs);
	const onInterrupt = (): void => {
		console.error("LIVE_FAIL: Error interrupted");
		process.exit(130);
	};
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onInterrupt);
	try {
		await runQa(config);
		clearTimeout(deadline);
		process.exit(0);
	} catch (error) {
		clearTimeout(deadline);
		fail(error, config.token);
	}
}

async function main(): Promise<void> {
	const outcome = parseConfig(process.env);
	switch (outcome.kind) {
		case "skip":
			console.log("skipped: DISCORD_BOT_TOKEN unset");
			process.exit(0);
			break;
		case "run":
			await run(outcome.config);
			break;
	}
}

// no-excuse-ok: top-level boundary, errors are converted to LIVE_FAIL lines.
await main().catch((error: unknown) => fail(error, ""));
