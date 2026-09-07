import { describe, expect, it } from "bun:test";
import { SocketClosedError } from "../src/bridge/intervention-client.ts";
import { BOT, msg, useInboundQueueHarness } from "./inbound-queue-fixtures.ts";

describe("inbound queue delivery and ack-driven cursor", () => {
	const harness = useInboundQueueHarness();

	it("injects three FIFO frames awaiting each ack when three running-turn messages arrive", async () => {
		const { agent, queue } = harness.setup(() => "hold");
		await queue.offer([msg("1"), msg("2"), msg("3")], "gateway");
		const drained = queue.drain();
		expect((await agent.nextFrame()).id).toBe("1");
		expect(agent.ids()).toEqual(["1"]);
		agent.ack("1");
		expect((await agent.nextFrame()).id).toBe("2");
		expect(agent.ids()).toEqual(["1", "2"]);
		agent.ack("2");
		expect((await agent.nextFrame()).id).toBe("3");
		agent.ack("3");
		await drained;
		expect(agent.peakInFlight()).toBe(1);
		expect(await harness.lastSeen()).toBe("3");
	});

	it("delivers every id exactly once with one inject in flight when drains overlap and an offer lands mid-flight", async () => {
		const { agent, queue } = harness.setup(() => "hold");
		await queue.offer([msg("1"), msg("2")], "gateway");
		const first = queue.drain();
		const second = queue.drain();
		expect((await agent.nextFrame()).id).toBe("1");
		await queue.offer([msg("3")], "catchup");
		const third = queue.drain();
		agent.ack("1");
		expect((await agent.nextFrame()).id).toBe("2");
		agent.ack("2");
		expect((await agent.nextFrame()).id).toBe("3");
		agent.ack("3");
		await Promise.all([first, second, third]);
		expect(agent.ids()).toEqual(["1", "2", "3"]);
		expect(agent.peakInFlight()).toBe(1);
		expect(queue.size()).toBe(0);
	});

	it("reports the acked human id and not the skipped bot id when a bot posts around it", async () => {
		const { agent, queue } = harness.setup();
		await queue.offer(
			[msg("1", { author: BOT }), msg("2"), msg("3", { author: BOT })],
			"gateway",
		);
		await queue.drain();
		expect(agent.ids()).toEqual(["2"]);
		expect(queue.lastAckedMessageId()).toBe("2");
		expect(await harness.lastSeen()).toBe("3");
	});

	it("keeps the message at the head and advances nothing when inject rejects with a skip behind it", async () => {
		const dead = new SocketClosedError("socket closed mid-flight");
		const { agent, queue } = harness.setup((id) => (id === "1" ? dead : "ack"));
		await queue.offer(
			[msg("1"), msg("2", { author: BOT }), msg("3")],
			"gateway",
		);
		await queue.drain();
		expect(agent.ids()).toEqual(["1"]);
		expect(queue.head()?.id).toBe("1");
		expect(queue.size()).toBe(3);
		expect(queue.lastAckedMessageId()).toBeUndefined();
		expect(await harness.lastSeen()).toBeUndefined();
	});

	it("replays the head message after restart when the ack never arrived", async () => {
		const dead = new SocketClosedError("socket closed mid-flight");
		const crashed = harness.setup(() => dead);
		await crashed.queue.offer([msg("7")], "gateway");
		await crashed.queue.drain();
		expect(await harness.lastSeen()).toBeUndefined();
		const restarted = harness.setup();
		await restarted.queue.offer([msg("7")], "catchup");
		await restarted.queue.drain();
		expect(restarted.agent.ids()).toEqual(["7"]);
		expect(restarted.queue.lastAckedMessageId()).toBe("7");
		expect(await harness.lastSeen()).toBe("7");
	});

	it("finishes the in-flight message and holds the rest when pause lands mid-flight", async () => {
		const { agent, queue } = harness.setup(() => "hold");
		await queue.offer([msg("1"), msg("2")], "gateway");
		const drained = queue.drain();
		agent.ack((await agent.nextFrame()).id);
		queue.pause();
		await drained;
		expect(agent.ids()).toEqual(["1"]);
		expect(queue.head()?.id).toBe("2");
		expect(await harness.lastSeen()).toBe("1");
	});

	it("holds the head while paused and delivers it when a repeated resume follows", async () => {
		const { agent, queue } = harness.setup();
		queue.pause();
		queue.pause();
		await queue.offer([msg("4")], "gateway");
		await queue.drain();
		expect(agent.ids()).toEqual([]);
		expect(queue.head()?.id).toBe("4");
		queue.resume();
		queue.resume();
		await queue.drain();
		expect(agent.ids()).toEqual(["4"]);
		expect(await harness.lastSeen()).toBe("4");
	});

	it("keeps delivering the next message when the accept reaction rejects", async () => {
		const { agent, queue } = harness.setup(() => "ack", {
			react: { accept: () => Promise.reject(new Error("missing permission")) },
		});
		await queue.offer([msg("6"), msg("7")], "gateway");
		await queue.drain();
		expect(agent.ids()).toEqual(["6", "7"]);
		expect(await harness.lastSeen()).toBe("7");
	});
});
