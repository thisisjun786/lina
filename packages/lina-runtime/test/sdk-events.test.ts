import { expect, test } from "bun:test";
import { decodeNativeEvent, projectNativeEntry } from "../src/sdk-events.ts";

const entry = {
	type: "message",
	id: "old-user",
	parentId: null,
	timestamp: "2026-09-05T00:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: "Original text" }] },
};

test("projection preserves raw source identity and omits private thinking from visible text", () => {
	expect(projectNativeEntry(entry)).toMatchObject({
		entryId: "old-user",
		role: "user",
		text: "Original text",
		raw: entry,
	});
	const assistant = {
		...entry,
		id: "answer",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: "Visible answer" },
			],
		},
	};
	expect(projectNativeEntry(assistant)?.text).toBe("Visible answer");
});

test("message_end and agent_end cannot commit history or claim settlement", () => {
	expect(
		decodeNativeEvent({ type: "message_end", message: entry.message }),
	).toBeUndefined();
	expect(
		decodeNativeEvent({ type: "agent_end", willRetry: false }),
	).toBeUndefined();
	expect(decodeNativeEvent({ type: "entry_appended", entry })).toMatchObject({
		type: "entry",
		entry: { entryId: "old-user" },
	});
	expect(decodeNativeEvent({ type: "agent_settled" })).toEqual({
		type: "settled",
	});
});

test("streaming is tentative and terminal provider errors stay visible", () => {
	expect(
		decodeNativeEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "part" },
		}),
	).toEqual({ type: "text", delta: "part" });
	expect(
		decodeNativeEvent({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Provider unavailable",
			},
		}),
	).toEqual({ type: "failure", error: "Provider unavailable" });
	expect(projectNativeEntry({ id: "broken" })).toBeUndefined();
});
