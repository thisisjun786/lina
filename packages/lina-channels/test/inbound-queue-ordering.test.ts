import { describe, expect, it } from "bun:test";
import {
	CHANNEL,
	msg,
	useInboundQueueHarness,
} from "./inbound-queue-fixtures.ts";

describe("inbound queue ordering and dedupe", () => {
	const harness = useInboundQueueHarness();

	it("delivers mixed-width duplicate snowflakes oldest-first once when one batch repeats an id", async () => {
		// 9 before 10 only holds under BigInt order; a lexicographic sort yields 1,10,9.
		const { agent, queue } = harness.setup();
		await queue.offer([msg("10"), msg("9"), msg("9"), msg("1")], "gateway");
		await queue.drain();
		expect(agent.ids()).toEqual(["1", "9", "10"]);
		expect(await harness.lastSeen()).toBe("10");
	});

	it("does not re-deliver an id when it was already seen from the other source", async () => {
		const { agent, queue } = harness.setup(() => "hold");
		await queue.offer([msg("8")], "gateway");
		await queue.offer([msg("8")], "catchup");
		const drained = queue.drain();
		expect((await agent.nextFrame()).id).toBe("8");
		agent.ack("8");
		await drained;
		expect(agent.ids()).toEqual(["8"]);
		expect(queue.size()).toBe(0);
	});

	it("ignores an id when it is at or below the cursor", async () => {
		await harness.cursor().write({
			version: 1,
			channelId: CHANNEL,
			lastSeenMessageId: "10",
		});
		const { agent, queue } = harness.setup();
		await queue.offer([msg("9"), msg("10"), msg("11")], "catchup");
		expect(queue.size()).toBe(1);
		await queue.drain();
		expect(agent.ids()).toEqual(["11"]);
	});

	it("re-admits the oldest id when more than 1000 later ids pushed it out of the seen set", async () => {
		const { queue } = harness.setup();
		const wave = Array.from({ length: 1001 }, (_, i) => msg(String(i + 1)));
		await queue.offer(wave, "gateway");
		await queue.offer([msg("2")], "catchup");
		expect(queue.size()).toBe(1001);
		await queue.offer([msg("1")], "catchup");
		expect(queue.size()).toBe(1002);
	});
});
