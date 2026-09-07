import { z } from "zod";
import { E2eError, type Mode } from "./e2e-harness.ts";
import type { FakeDiscord, FakeDiscordEvent } from "./fake-discord.ts";
import type { RestRequestRecord } from "./fake-discord-types.ts";

const OkSchema = z.object({ ok: z.literal(true) }).strict();

function fail(reason: string): never {
	throw new E2eError(reason);
}

export async function failNextPost(fake: FakeDiscord): Promise<void> {
	const response = await fetch(`${fake.baseUrl}/__control/fail-next-post`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ count: 1 }),
	});
	if (!response.ok) fail("REST assertion: retry control failed");
	OkSchema.parse(await response.json());
}

export function postEvents(
	fake: FakeDiscord,
	after = 0,
): readonly Extract<FakeDiscordEvent, { readonly kind: "post" }>[] {
	return fake
		.events()
		.slice(after)
		.filter((event) => event.kind === "post");
}

export function requestEvents(
	fake: FakeDiscord,
	after = 0,
): readonly RestRequestRecord[] {
	return fake
		.events()
		.slice(after)
		.filter((event) => event.kind === "request")
		.map((event) => event.request);
}

export function assertHandshake(fake: FakeDiscord, mode: Mode): void {
	const handshake = fake.handshake();
	if (mode === "gateway-off") {
		if (
			handshake.queries.length !== 0 ||
			handshake.identifies.length !== 0 ||
			handshake.heartbeatCount !== 0
		)
			fail("handshake assertion: gateway-off opened Gateway traffic");
		console.log("HANDSHAKE_ASSERT gateway-off connections=0");
		return;
	}
	if (
		handshake.queries.length === 0 ||
		handshake.queries.some((query) => query !== "v=10&encoding=json")
	)
		fail("handshake assertion: query contract mismatch");
	if (
		handshake.identifies.length !== handshake.queries.length ||
		handshake.identifies.some(
			(identify) =>
				identify.token !== "fake" ||
				identify.intents !== 33_281 ||
				identify.properties.os !== "linux" ||
				identify.properties.browser !== "@discordjs/ws 1.2.3" ||
				identify.properties.device !== "@discordjs/ws 1.2.3",
		)
	)
		fail("handshake assertion: IDENTIFY contract mismatch");
	if (
		handshake.heartbeatCount < 1 ||
		handshake.ackCount !== handshake.heartbeatCount
	)
		fail("handshake assertion: heartbeat was not ACKed");
	if (handshake.rejections.length !== 0)
		fail("handshake assertion: valid client was rejected");
	console.log(
		`HANDSHAKE_ASSERT query=v=10&encoding=json identifies=${handshake.identifies.length} heartbeats=${handshake.heartbeatCount} acks=${handshake.ackCount}`,
	);
}

export function assertRetryPost(
	fake: FakeDiscord,
	after: number,
	expected: { readonly content: string; readonly replyTo: string },
): void {
	const requests = requestEvents(fake, after).filter(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/v10/channels/123/messages",
	);
	if (requests.length !== 2)
		fail(`REST assertion: expected 2 POST attempts, got ${requests.length}`);
	const first = JSON.stringify(requests[0]?.body);
	const second = JSON.stringify(requests[1]?.body);
	if (first !== second)
		fail("REST assertion: POST retry body or nonce changed");
	const body = requests[0]?.body;
	const parsed = z
		.object({
			content: z.literal(expected.content),
			nonce: z
				.string()
				.length(25)
				.regex(/^[0-9a-f]+$/),
			enforce_nonce: z.literal(true),
			allowed_mentions: z.object({ parse: z.tuple([]) }).strict(),
			message_reference: z
				.object({ message_id: z.literal(expected.replyTo) })
				.strict(),
		})
		.strict()
		.safeParse(body);
	if (!parsed.success) fail("REST assertion: POST body contract mismatch");
	if (postEvents(fake, after).length !== 1)
		fail("REST assertion: retry created other than one Discord message");
	console.log(
		`RETRY_ASSERT attempts=2 nonce=${parsed.data.nonce} successful_posts=1`,
	);
}

type ReactionExpectation = {
	readonly fake: FakeDiscord;
	readonly after: number;
	readonly humanId: string;
};
export function assertReactionRoutes(
	expectedRoutes: ReactionExpectation,
): void {
	const routes = requestEvents(expectedRoutes.fake, expectedRoutes.after)
		.filter((request) => request.path.includes("/reactions/"))
		.map((request) => `${request.method} ${request.path}`);
	const expected = [
		`PUT /api/v10/channels/123/messages/${expectedRoutes.humanId}/reactions/%F0%9F%91%80/@me`,
		`DELETE /api/v10/channels/123/messages/${expectedRoutes.humanId}/reactions/%F0%9F%91%80/@me`,
		`PUT /api/v10/channels/123/messages/${expectedRoutes.humanId}/reactions/%F0%9F%91%8D/@me`,
	];
	if (JSON.stringify(routes) !== JSON.stringify(expected))
		fail(`REST assertion: reaction routes differ: ${JSON.stringify(routes)}`);
	console.log(`REACTION_ASSERT ${routes.join(" | ")}`);
}

export function assertRestTrace(fake: FakeDiscord, mode: Mode): void {
	const requests = requestEvents(fake);
	if (!requests.some((request) => request.path === "/api/v10/users/@me"))
		fail("REST trace: /users/@me missing");
	if (
		!requests.some((request) =>
			request.path.startsWith("/api/v10/channels/123/messages?"),
		)
	)
		fail("REST trace: channel GET missing");
	const hasGatewayBot = requests.some(
		(request) => request.path === "/api/v10/gateway/bot",
	);
	if (hasGatewayBot !== (mode !== "gateway-off"))
		fail("REST trace: gateway/bot mode mismatch");
	if (
		requests.some(
			(request) =>
				!request.path.startsWith("/api/v10/") &&
				!request.path.startsWith("/__control/"),
		)
	)
		fail("REST trace: non-local route recorded");
	console.log(`REST_TRACE requests=${requests.length} external=0`);
}
