import { expect, test } from "bun:test";
import { historyFromTurns, projectCodexItem } from "../src/events.ts";

test("only explicitly final Codex answers carry the completed-message marker", () => {
	const item = { id: "assistant", type: "agentMessage", text: "complete" };
	expect(
		projectCodexItem({ ...item, phase: "final_answer" })?.message,
	).toMatchObject({ stopReason: "stop" });
	for (const phase of [undefined, "commentary", "unknown"]) {
		expect(projectCodexItem({ ...item, phase })?.message).not.toHaveProperty(
			"stopReason",
		);
	}
	expect(
		historyFromTurns([
			{
				id: "turn",
				status: "completed",
				items: [{ ...item, phase: "final_answer" }],
			},
		])[0]?.message,
	).toMatchObject({ stopReason: "stop" });
});

test("rehydrated item aliases and repeated identical messages keep stable distinct identities per turn", () => {
	const original = [
		{
			id: "turn-1",
			items: [
				{
					id: "live-user",
					type: "userMessage",
					content: [{ type: "text", text: "same" }],
				},
				{ id: "live-assistant", type: "agentMessage", text: "same" },
			],
		},
	];
	const replay = [
		{
			id: "turn-1",
			items: [
				{
					id: "item-1",
					type: "userMessage",
					content: [{ type: "text", text: "same" }],
				},
				{ id: "item-2", type: "agentMessage", text: "same" },
			],
		},
		{
			id: "turn-2",
			items: [
				{
					id: "item-3",
					type: "userMessage",
					content: [{ type: "text", text: "same" }],
				},
			],
		},
	];
	const first = historyFromTurns(original),
		restored = historyFromTurns(replay);
	expect(restored.slice(0, 2).map((e) => e.id)).toEqual(first.map((e) => e.id));
	expect(new Set(restored.map((e) => e.id)).size).toBe(3);
	expect(
		projectCodexItem(original[0]?.items[0], undefined, {
			turnId: "turn-1",
			ordinal: 0,
		})?.id,
	).toBe(restored[0]?.id);
});
