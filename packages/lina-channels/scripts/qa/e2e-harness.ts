import { join } from "node:path";
import { z } from "zod";
import type { InterventionServer } from "../../../lina-runtime/src/intervention/ws-server.ts";
import type { FakeDiscord, FakeDiscordEvent } from "./fake-discord.ts";

const DEADLINE_MS = 20_000;
export const CHANNEL_ID = "123" as const;
export const ALLOWED_ID = "777" as const;
export type Mode = "gateway" | "gateway-off" | "reconnect";
export type SinkCall = {
	readonly text: string;
	readonly deliverAs: string | undefined;
};
export class E2eError extends Error {
	override readonly name = "E2eError";
}

export function withinDeadline<T>(
	promise: Promise<T>,
	reason: string,
): Promise<T> {
	const expired = Promise.withResolvers<T>();
	const timer = setTimeout(
		() => expired.reject(new E2eError(reason)),
		DEADLINE_MS,
	);
	return Promise.race([promise, expired.promise]).finally(() =>
		clearTimeout(timer),
	);
}

export type EventStream<T> = {
	readonly push: (value: T) => void;
	readonly count: () => number;
	readonly values: () => readonly T[];
	readonly wait: (
		predicate: (value: T) => boolean,
		after?: number,
		reason?: string,
	) => Promise<T>;
};
export function eventStream<T>(): EventStream<T> {
	const history: T[] = [];
	const listeners = new Set<(value: T) => void>();
	return {
		push(value) {
			history.push(value);
			for (const listener of listeners) listener(value);
		},
		count: () => history.length,
		values: () => [...history],
		wait(predicate, after = 0, reason = "event timeout") {
			const found = history.slice(after).find(predicate);
			if (found !== undefined) return Promise.resolve(found);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(listener);
					reject(new E2eError(reason));
				}, DEADLINE_MS);
				const listener = (value: T): void => {
					if (!predicate(value)) return;
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(value);
				};
				listeners.add(listener);
			});
		},
	};
}

export type LineMonitor = EventStream<string>;
function monitorLines(stream: ReadableStream<Uint8Array>): LineMonitor {
	const monitor = eventStream<string>();
	void (async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			pending += decoder.decode(result.value, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				console.log(`DAEMON ${line}`);
				monitor.push(line);
			}
		}
		if (pending.length > 0) {
			console.log(`DAEMON ${pending}`);
			monitor.push(pending);
		}
	})();
	return monitor;
}

export type Daemon = {
	readonly process: Bun.Subprocess;
	readonly lines: LineMonitor;
};
type SpawnOptions = {
	readonly fake: FakeDiscord;
	readonly interventionPort: number;
	readonly cursorPath: string;
	readonly mode: Mode;
};
export function spawnDaemon(options: SpawnOptions): Daemon {
	const { E2E_ALLOWED_USER_IDS: allowedIds } = process.env;
	const child = Bun.spawn(
		["bun", "packages/lina-channels/src/discord-bridge.ts"],
		{
			cwd: join(import.meta.dir, "../../../.."),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				DISCORD_BOT_TOKEN: "fake",
				DISCORD_CHANNEL_ID: CHANNEL_ID,
				LINA_DISCORD_ALLOWED_USER_IDS: allowedIds ?? ALLOWED_ID,
				LINA_DISCORD_REST_API: `${options.fake.baseUrl}/api/v10`,
				LINA_INTERVENTION_URL: `ws://127.0.0.1:${options.interventionPort}`,
				LINA_DISCORD_CURSOR_PATH: options.cursorPath,
				LINA_DISCORD_CATCHUP_MS: "5000",
				LINA_DISCORD_GATEWAY: options.mode === "gateway-off" ? "off" : "on",
			},
		},
	);
	return { process: child, lines: monitorLines(child.stderr) };
}

export async function stopDaemon(
	daemon: Daemon,
	signal: "SIGINT" | "SIGTERM" = "SIGTERM",
): Promise<void> {
	if (daemon.process.exitCode !== null) {
		console.log(`CLEANUP daemon_pid=${daemon.process.pid} repeated=true`);
		return;
	}
	daemon.process.kill(signal);
	try {
		await withinDeadline(
			daemon.process.exited,
			"daemon did not exit after SIGTERM",
		);
	} catch (error) {
		daemon.process.kill("SIGKILL");
		await withinDeadline(
			daemon.process.exited,
			"daemon did not exit after SIGKILL",
		);
		throw error;
	}
	console.log(
		`CLEANUP daemon_pid=${daemon.process.pid} signal=${signal} exited`,
	);
}

export async function inject(
	fake: FakeDiscord,
	authorId: string,
	content: string,
): Promise<string> {
	const response = await fetch(
		`${fake.baseUrl}/__control/inject?channelId=${CHANNEL_ID}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ authorId, content }),
		},
	);
	return z.object({ id: z.string() }).parse(await response.json()).id;
}

const PostBodySchema = z.object({
	content: z.string(),
	message_reference: z.object({ message_id: z.string() }),
	allowed_mentions: z.object({ parse: z.array(z.string()).length(0) }),
	enforce_nonce: z.literal(true),
	nonce: z.string(),
});
export function assertPost(
	event: FakeDiscordEvent,
	expected: { readonly content: string; readonly replyTo: string },
): string {
	if (event.kind !== "post") throw new E2eError("step 6: expected post event");
	const body = PostBodySchema.parse(event.body);
	if (body.content !== expected.content)
		throw new E2eError(`step 6: wrong content ${body.content}`);
	if (body.message_reference.message_id !== expected.replyTo)
		throw new E2eError("step 6: wrong message reference");
	console.log(`ASSERT_POST ${JSON.stringify(body)}`);
	return event.message.id;
}

type ResponseOptions = {
	readonly server: InterventionServer;
	readonly lines: LineMonitor;
	readonly calls: EventStream<SinkCall>;
	readonly callIndex: number;
	readonly injectedId: string;
	readonly text: string;
};
export async function respond(options: ResponseOptions): Promise<void> {
	await options.calls.wait(
		(call) => call.text === options.text && call.deliverAs === "steer",
		options.callIndex,
		"step 5: no sendUserMessage within 20s",
	);
	await options.lines.wait(
		(line) => line === `[discord-bridge] injected ${options.injectedId}`,
		0,
		"step 5: no correlated ack within 20s",
	);
	options.server.broadcast({ type: "agent-status", state: "running" });
	options.server.broadcast({
		type: "agent-text",
		text: `echo: ${options.text}`,
	});
	options.server.broadcast({ type: "agent-status", state: "idle" });
}

export async function ready(daemon: Daemon, mode: Mode): Promise<void> {
	await daemon.lines.wait(
		(line) => line === "[discord-bridge] intervention: connected",
		0,
		"startup: intervention not connected",
	);
	const anchor =
		mode === "gateway-off"
			? "[discord-bridge] gateway disabled"
			: "[discord-bridge] gateway ready";
	await daemon.lines.wait(
		(line) => line === anchor,
		0,
		`startup: ${anchor} missing`,
	);
}
