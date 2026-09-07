import { z } from "zod";
import {
	BOT_ID,
	BOT_TOKEN,
	CHANNEL_ID,
	type FakeDiscordEvent,
	type HandshakeSnapshot,
	type IdentifyRecord,
	USER_ID,
} from "./fake-discord-types.ts";

const HEARTBEAT_MS = 250;
const EXPECTED_QUERY = "v=10&encoding=json";
const IdentifySchema = z.object({
	op: z.literal(2),
	d: z
		.object({
			token: z.literal(BOT_TOKEN),
			intents: z.literal(33_281),
			properties: z
				.object({
					os: z.literal("linux"),
					browser: z.literal("@discordjs/ws 1.2.3"),
					device: z.literal("@discordjs/ws 1.2.3"),
				})
				.strict(),
		})
		.passthrough(),
});
const HeartbeatSchema = z
	.object({ op: z.literal(1), d: z.number().nullable() })
	.strict();

export type GatewayData = { readonly requestUrl: string };
type GatewayResult =
	| { readonly kind: "identify"; readonly frames: readonly string[] }
	| { readonly kind: "heartbeat"; readonly frame: string }
	| { readonly kind: "reject"; readonly reason: string };
type GatewayRecorderOptions = {
	readonly emit: (event: FakeDiscordEvent) => void;
	readonly port: () => number | undefined;
	readonly nextSequence: () => number;
};
export type GatewayRecorder = {
	readonly open: (requestUrl: string) => string | undefined;
	readonly receive: (raw: string | Buffer | ArrayBuffer) => GatewayResult;
	readonly snapshot: () => HandshakeSnapshot;
};

export function gatewayBody(port: number): unknown {
	return {
		url: `ws://127.0.0.1:${port}/gateway`,
		shards: 1,
		session_start_limit: {
			total: 1000,
			remaining: 999,
			reset_after: 0,
			max_concurrency: 1,
		},
	};
}

function identifyFrames(
	port: number,
	sequence: () => number,
): readonly string[] {
	return [
		JSON.stringify({
			op: 0,
			t: "READY",
			s: sequence(),
			d: {
				v: 10,
				user: { id: BOT_ID, bot: true, username: "lina" },
				session_id: "fake-session",
				resume_gateway_url: `ws://127.0.0.1:${port}/gateway`,
				guilds: [],
				application: { id: BOT_ID, flags: 0 },
			},
		}),
		JSON.stringify({
			op: 0,
			t: "CHANNEL_CREATE",
			s: sequence(),
			d: {
				id: CHANNEL_ID,
				type: 1,
				recipients: [
					{ id: USER_ID, username: "tester", discriminator: "0", avatar: null },
				],
				last_message_id: null,
			},
		}),
	];
}

function decode(raw: string | Buffer | ArrayBuffer): unknown {
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
	return JSON.parse(text);
}

export function createGatewayRecorder(
	options: GatewayRecorderOptions,
): GatewayRecorder {
	const queries: string[] = [];
	const identifies: IdentifyRecord[] = [];
	const rejections: string[] = [];
	let heartbeatCount = 0;
	let ackCount = 0;
	const reject = (reason: string): GatewayResult => {
		rejections.push(reason);
		options.emit({ kind: "gateway", state: "rejected", detail: reason });
		return { kind: "reject", reason };
	};
	return {
		open(requestUrl) {
			const query = new URL(requestUrl).searchParams.toString();
			queries.push(query);
			if (query !== EXPECTED_QUERY) {
				rejections.push(`invalid query: ${query}`);
				options.emit({
					kind: "gateway",
					state: "rejected",
					detail: `invalid query: ${query}`,
				});
				return undefined;
			}
			options.emit({ kind: "gateway", state: "connected", detail: query });
			return JSON.stringify({
				op: 10,
				d: { heartbeat_interval: HEARTBEAT_MS },
			});
		},
		receive(raw) {
			let payload: unknown;
			try {
				payload = decode(raw);
			} catch (error) {
				if (error instanceof SyntaxError) return reject("invalid gateway JSON");
				throw error;
			}
			const heartbeat = HeartbeatSchema.safeParse(payload);
			if (heartbeat.success) {
				heartbeatCount += 1;
				ackCount += 1;
				options.emit({ kind: "gateway", state: "heartbeat" });
				return {
					kind: "heartbeat",
					frame: JSON.stringify({ op: 11, d: null }),
				};
			}
			const identify = IdentifySchema.safeParse(payload);
			if (!identify.success) return reject("invalid IDENTIFY");
			const port = options.port();
			if (port === undefined) return reject("fake Discord is not listening");
			identifies.push({
				token: identify.data.d.token,
				intents: identify.data.d.intents,
				properties: identify.data.d.properties,
			});
			options.emit({ kind: "gateway", state: "identified" });
			return {
				kind: "identify",
				frames: identifyFrames(port, options.nextSequence),
			};
		},
		snapshot: () => ({
			queries: [...queries],
			identifies: [...identifies],
			heartbeatCount,
			ackCount,
			rejections: [...rejections],
		}),
	};
}
