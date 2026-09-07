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

test("new native epochs cannot collide and use the same live and history identity", () => {
	const item = { id: "native-item", type: "agentMessage", text: "same" };
	const turns = [{ id: "turn", items: [item] }];
	expect(historyFromTurns(turns)[0]?.id).toBe("codex:turn:assistant:0");
	const one = historyFromTurns(turns, 1)[0];
	const two = historyFromTurns(turns, 2)[0];
	expect(one?.id).toBe("codex-v2:1:turn:assistant:0");
	expect(two?.id).toBe("codex-v2:2:turn:assistant:0");
	expect(
		projectCodexItem(item, 0, { turnId: "turn", ordinal: 0, nativeEpoch: 2 })
			?.id,
	).toBe(two?.id);
});

test("epoch IDs cannot alias a legacy turn whose ID resembles the new version marker", () => {
	const item = { id: "item", type: "agentMessage", text: "same" };
	const legacy = projectCodexItem(item, 0, { turnId: "v2:1:turn", ordinal: 0 });
	const current = projectCodexItem(item, 0, {
		turnId: "turn",
		ordinal: 0,
		nativeEpoch: 1,
	});
	expect(current?.id).not.toBe(legacy?.id);
});
