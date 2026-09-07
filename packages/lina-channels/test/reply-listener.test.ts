import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChannelAdapter,
	type SessionInjector,
	startReplyListener,
} from "../src/reply-listener.ts";
import { SessionRegistry } from "../src/session-registry.ts";
import {
	type InboundMessage,
	InboundMessageSchema,
	RegistryEntrySchema,
	type SessionId,
} from "../src/types.ts";

class FakeAdapter implements ChannelAdapter {
	readonly channel = "discord" as const;
	messages: InboundMessage[] = [];

	poll(_since: string | undefined): Promise<readonly InboundMessage[]> {
		return Promise.resolve(this.messages);
	}
}

class FakeInjector implements SessionInjector {
	readonly calls: { readonly sessionId: SessionId; readonly text: string }[] =
		[];

	inject(sessionId: SessionId, text: string): Promise<void> {
		this.calls.push({ sessionId, text });
		return Promise.resolve();
	}
}

async function tempRegistry(): Promise<SessionRegistry> {
	const dir = await mkdtemp(join(tmpdir(), "lina-channels-"));
	return new SessionRegistry(join(dir, "registry.jsonl"));
}

describe("reply listener", () => {
	it("injects inbound text into the mapped session when tick polls a reply", async () => {
		const registry = await tempRegistry();
		const outbound = RegistryEntrySchema.parse({
			messageId: "out-1",
			sessionId: "sess-9",
			channel: "discord",
			channelId: "chan-9",
			recordedAt: "2026-09-04T00:00:00.000Z",
		});
		await registry.record(outbound);

		const adapter = new FakeAdapter();
		adapter.messages = [
			InboundMessageSchema.parse({
				channel: "discord",
				messageId: "in-1",
				channelId: "chan-9",
				authorId: "user-1",
				text: "hello from discord",
				receivedAt: "2026-09-04T00:00:05.000Z",
				replyTo: "out-1",
			}),
		];
		const injector = new FakeInjector();
		const listener = startReplyListener({
			adapters: [adapter],
			registry,
			injector,
			pollIntervalMs: 0,
			rateLimitPerMinute: 10,
		});

		await listener.tick();

		expect(injector.calls).toEqual([
			{ sessionId: outbound.sessionId, text: "hello from discord" },
		]);
		listener.stop();
	});

	it("blocks the N+1th inject when the rate limit is reached within the same minute", async () => {
		const registry = await tempRegistry();
		const first = RegistryEntrySchema.parse({
			messageId: "out-a",
			sessionId: "sess-a",
			channel: "discord",
			channelId: "chan-a",
			recordedAt: "2026-09-04T00:00:00.000Z",
		});
		const second = RegistryEntrySchema.parse({
			messageId: "out-b",
			sessionId: "sess-b",
			channel: "discord",
			channelId: "chan-b",
			recordedAt: "2026-09-04T00:00:00.000Z",
		});
		await registry.record(first);
		await registry.record(second);

		const adapter = new FakeAdapter();
		adapter.messages = [
			InboundMessageSchema.parse({
				channel: "discord",
				messageId: "in-a",
				channelId: "chan-a",
				authorId: "user-a",
				text: "one",
				receivedAt: "2026-09-04T00:00:05.000Z",
				replyTo: "out-a",
			}),
			InboundMessageSchema.parse({
				channel: "discord",
				messageId: "in-b",
				channelId: "chan-b",
				authorId: "user-b",
				text: "two",
				receivedAt: "2026-09-04T00:00:06.000Z",
				replyTo: "out-b",
			}),
		];
		const injector = new FakeInjector();
		const listener = startReplyListener({
			adapters: [adapter],
			registry,
			injector,
			pollIntervalMs: 0,
			rateLimitPerMinute: 1,
			now: () => 1_000,
		});

		await listener.tick();

		expect(injector.calls).toEqual([
			{ sessionId: first.sessionId, text: "one" },
		]);
		listener.stop();
	});
});
