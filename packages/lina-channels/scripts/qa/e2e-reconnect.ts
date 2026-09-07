import { startInterventionServer } from "../../../lina-runtime/src/intervention/ws-server.ts";
import { postEvents, requestEvents } from "./e2e-assertions.ts";
import {
	ALLOWED_ID,
	assertPost,
	type Daemon,
	E2eError,
	type EventStream,
	inject,
	respond,
	type SinkCall,
	withinDeadline,
} from "./e2e-harness.ts";
import type { FakeDiscord, FakeDiscordEvent } from "./fake-discord.ts";

const PARTIAL = "partial must be discarded";
const QUEUED = "queued while intervention is down";
type ReconnectOptions = {
	readonly firstId: string;
	readonly fake: FakeDiscord;
	readonly fakeEvents: EventStream<FakeDiscordEvent>;
	readonly calls: EventStream<SinkCall>;
	readonly intervention: Awaited<ReturnType<typeof startInterventionServer>>;
	readonly daemon: Daemon;
	readonly sink: {
		readonly sendUserMessage: (
			text: string,
			options?: { readonly deliverAs?: "steer" | "followUp" },
		) => void;
	};
};

export async function runReconnect(options: ReconnectOptions): Promise<void> {
	await options.calls.wait(
		(call) => call.text === "hello lina",
		0,
		"first reconnect send missing",
	);
	await options.daemon.lines.wait(
		(line) => line === `[discord-bridge] injected ${options.firstId}`,
		0,
		"first reconnect ACK missing",
	);
	options.intervention.broadcast({ type: "agent-status", state: "running" });
	options.intervention.broadcast({ type: "agent-text", text: PARTIAL });
	const partialGate = options.fakeEvents.count();
	await options.fakeEvents.wait(
		(event) => event.kind === "gateway" && event.state === "heartbeat",
		partialGate,
		"partial turn transport gate missing",
	);
	const port = options.intervention.port;
	await withinDeadline(
		options.intervention.stop(),
		"intervention stop timed out",
	);
	await options.daemon.lines.wait(
		(line) => line === "[discord-bridge] intervention: disconnected",
		0,
		"intervention disconnect missing",
	);
	const callsWhileDown = options.calls.count();
	const postsWhileDown = postEvents(options.fake).length;
	const downGate = options.fakeEvents.count();
	await inject(options.fake, ALLOWED_ID, QUEUED);
	await options.fakeEvents.wait(
		(event) => event.kind === "gateway" && event.state === "heartbeat",
		downGate,
		"disconnected queue gate missing",
	);
	if (
		options.calls.count() !== callsWhileDown ||
		postEvents(options.fake).length !== postsWhileDown
	)
		throw new E2eError("reconnect: intervention-down sources were not paused");
	console.log(
		"DISCONNECT_ASSERT partial=true queued_while_down=true calls_unchanged=true posts_unchanged=true",
	);

	const restored = await startInterventionServer({
		port,
		currentStatus: () => "idle",
		sink: options.sink,
	});
	try {
		await options.daemon.lines.wait(
			(line) => line === "[discord-bridge] intervention: connected",
			1,
			"intervention reconnect missing",
		);
		const eventIndex = options.fakeEvents.count();
		const queuedCall = await options.calls.wait(
			(call) => call.text === QUEUED,
			callsWhileDown,
			"queued message not delivered",
		);
		if (queuedCall.deliverAs !== "steer")
			throw new E2eError("queued message did not preserve steer delivery");
		const queuedId = options.fake
			.events()
			.find(
				(event) => event.kind === "inject" && event.message.content === QUEUED,
			);
		if (queuedId?.kind !== "inject")
			throw new E2eError("queued injection record missing");
		await respond({
			server: restored,
			lines: options.daemon.lines,
			calls: options.calls,
			callIndex: callsWhileDown,
			injectedId: queuedId.message.id,
			text: QUEUED,
		});
		const post = await options.fakeEvents.wait(
			(event) => event.kind === "post",
			eventIndex,
			"queued reply missing",
		);
		assertPost(post, {
			content: `echo: ${QUEUED}`,
			replyTo: queuedId.message.id,
		});
		const drainEvent = options.fakeEvents.count();
		const drainLine = options.daemon.lines.count();
		await options.fakeEvents.wait(
			(event) => event.kind === "catchup",
			drainEvent,
			"post-reconnect catch-up missing",
		);
		await options.daemon.lines.wait(
			(line) => line.startsWith("[discord-bridge] catch-up:"),
			drainLine,
			"post-reconnect drain cycle missing",
		);
		if (
			options.calls.count() !== callsWhileDown + 1 ||
			postEvents(options.fake).length !== postsWhileDown + 1
		)
			throw new E2eError(
				"reconnect: queued message was not delivered exactly once",
			);
		if (
			requestEvents(options.fake).some((request) =>
				(JSON.stringify(request.body) ?? "").includes(PARTIAL),
			)
		)
			throw new E2eError(
				"reconnect: discarded partial text reached Discord REST",
			);
		console.log(
			"RECONNECT_ASSERT partial_discarded=true queued_exactly_once=true synchronized_idle=true",
		);
	} finally {
		await withinDeadline(
			restored.stop(),
			"restored intervention stop timed out",
		);
	}
}
