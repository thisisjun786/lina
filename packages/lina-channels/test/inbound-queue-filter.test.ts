import { describe, expect, it } from "bun:test";
import {
	BOT,
	HUMAN,
	msg,
	OTHER_BOT,
	STRANGER,
	useInboundQueueHarness,
} from "./inbound-queue-fixtures.ts";

describe("inbound queue filter order", () => {
	const harness = useInboundQueueHarness();

	it("skips self, other bots, denied users and blank text and still advances the cursor when they post", async () => {
		// The bot ids sit ON the allowlist: only self-first, bot-second order skips them.
		const { agent, queue } = harness.setup(() => "ack", {
			allowed: [HUMAN, BOT, OTHER_BOT],
		});
		await queue.offer(
			[
				msg("10", { author: BOT }),
				msg("11", { author: OTHER_BOT, bot: true }),
				msg("12", { author: STRANGER }),
				msg("13", { content: " \n\t " }),
			],
			"gateway",
		);
		await queue.drain();
		expect(agent.ids()).toEqual([]);
		expect(queue.size()).toBe(0);
		expect(await harness.lastSeen()).toBe("13");
	});

	it("denies everyone when the allowlist is empty", async () => {
		const { agent, queue } = harness.setup(() => "ack", { allowed: [] });
		await queue.offer([msg("5"), msg("6", { author: STRANGER })], "catchup");
		await queue.drain();
		expect(agent.ids()).toEqual([]);
		expect(await harness.lastSeen()).toBe("6");
	});

	it("skips the message when an allowed user posts only ideographic space", async () => {
		// A CJK IME produces U+3000; it is whitespace to trim(), so it must not
		// reach the agent as an empty prompt.
		const { agent, queue } = harness.setup();
		await queue.offer(
			[msg("7", { content: "\u3000\u3000" }), msg("8")],
			"gateway",
		);
		await queue.drain();
		expect(agent.ids()).toEqual(["8"]);
		expect(await harness.lastSeen()).toBe("8");
	});
});
