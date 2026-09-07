import { describe, expect, it } from "bun:test";
import { installIdleNudge } from "../src/watcher/idle-nudge.ts";

describe("idle nudge", () => {
	it("injects the nudge text when the agent has been idle past the timeout", async () => {
		const sent: string[] = [];
		const handlers = new Map<string, () => void>();
		const nudge = installIdleNudge(
			{
				on: (event: string, handler: () => void) => {
					handlers.set(event, handler);
				},
				sendUserMessage: (c: string) => {
					sent.push(c);
				},
			},
			{ idleTimeoutMs: 10, nudgeText: "wake up" },
		);
		handlers.get("agent_end")?.();
		await nudge.nextNudge();
		expect(sent).toEqual(["wake up"]);
		nudge.stop();
	});

	it("does not nudge when the agent is running", async () => {
		const sent: string[] = [];
		const handlers = new Map<string, () => void>();
		const nudge = installIdleNudge(
			{
				on: (event: string, handler: () => void) => {
					handlers.set(event, handler);
				},
				sendUserMessage: (c: string) => {
					sent.push(c);
				},
			},
			{ idleTimeoutMs: 10, nudgeText: "wake up" },
		);
		handlers.get("agent_end")?.();
		handlers.get("agent_start")?.();
		expect(nudge.isArmed()).toBe(false);
		expect(sent).toEqual([]);
		nudge.stop();
	});
});
