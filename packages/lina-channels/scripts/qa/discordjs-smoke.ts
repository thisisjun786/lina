import { Client, GatewayIntentBits } from "discord.js";
import {
	type FakeGateway,
	type IdentifyCapture,
	startFakeGateway,
} from "./fake-gateway.ts";

const SMOKE_DEADLINE_MS = 15_000;
const SMOKE_TOKEN = "smoke-local-token";

type HandshakeWinner =
	| { readonly kind: "identified"; readonly capture: IdentifyCapture }
	| { readonly kind: "login_ok" }
	| { readonly kind: "login_error"; readonly error: unknown };

function assertNever(value: never): never {
	throw new Error(`unexpected variant: ${JSON.stringify(value)}`);
}

function redact(text: string): string {
	return text
		.replaceAll(SMOKE_TOKEN, "[REDACTED]")
		.replaceAll(/Bot\s+\S+/g, "Bot [REDACTED]");
}

function formatSmokeError(error: unknown): string {
	const bits: string[] = [];
	if (error instanceof Error) {
		bits.push(error.message);
		if (
			"code" in error &&
			(typeof error.code === "string" || typeof error.code === "number")
		) {
			bits.push(`code=${error.code}`);
		}
		if (error.cause !== undefined) {
			bits.push(`cause=${formatSmokeError(error.cause)}`);
		}
	} else {
		bits.push(String(error));
	}
	const text = bits.join(" | ");
	const refused =
		/ECONNREFUSED|ConnectionRefused|connection refused|Unable to connect/i.test(
			text,
		);
	if (refused && !text.includes("ECONNREFUSED")) {
		return redact(`${text} (ECONNREFUSED)`);
	}
	return redact(text);
}

async function waitForIdentify(
	client: Client,
	identified: Promise<IdentifyCapture>,
): Promise<IdentifyCapture> {
	const abort = new AbortController();
	const loginOutcome: Promise<HandshakeWinner> = client.login(SMOKE_TOKEN).then(
		() => ({ kind: "login_ok" as const }),
		(error: unknown) => ({ kind: "login_error" as const, error }),
	);
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`discord.js handshake timed out after ${SMOKE_DEADLINE_MS}ms`,
				),
			);
		}, SMOKE_DEADLINE_MS);
		abort.signal.addEventListener("abort", () => clearTimeout(timer), {
			once: true,
		});
	});
	try {
		const winner: HandshakeWinner = await Promise.race([
			identified.then((capture) => ({
				kind: "identified" as const,
				capture,
			})),
			loginOutcome,
			timeout,
		]);
		switch (winner.kind) {
			case "identified":
				return winner.capture;
			case "login_ok":
				throw new Error("client.login resolved before IDENTIFY");
			case "login_error":
				throw winner.error instanceof Error
					? winner.error
					: new Error(String(winner.error));
			default:
				return assertNever(winner);
		}
	} finally {
		abort.abort();
	}
}

function releaseSmoke(
	client: Client | undefined,
	gateway: FakeGateway | undefined,
): void {
	if (client !== undefined) {
		void client.destroy();
	}
	if (gateway !== undefined) {
		gateway.stop();
	}
}

async function runSmoke(): Promise<void> {
	const gateway = startFakeGateway();
	const restKey = "SMOKE_REST_API";
	const restOverride = process.env[restKey];
	const api =
		restOverride !== undefined && restOverride.length > 0
			? restOverride
			: `http://127.0.0.1:${gateway.port}/api`;
	if (api.includes("discord.com")) {
		releaseSmoke(undefined, gateway);
		throw new Error("refusing to contact discord.com");
	}
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
		rest: { api },
	});
	const onInterrupt = (): void => {
		releaseSmoke(client, gateway);
		process.exit(130);
	};
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onInterrupt);
	try {
		const capture = await waitForIdentify(client, gateway.identified);
		console.log(`SMOKE_OK query=${capture.query} intents=${capture.intents}`);
	} finally {
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onInterrupt);
		releaseSmoke(client, gateway);
	}
}

async function main(): Promise<void> {
	// no-excuse-ok: catch
	try {
		await runSmoke();
		process.exit(0);
	} catch (error) {
		console.error(`SMOKE_FAIL ${formatSmokeError(error)}`);
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}
