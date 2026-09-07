import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DurableStore } from "../src/store.ts";
import { entry, Fixture } from "./fixture.ts";

describe("normal assistant reply predicate", () => {
	let fixture: Fixture;
	let store: DurableStore;
	beforeEach(() => {
		fixture = new Fixture();
		store = fixture.store();
	});
	afterEach(() => fixture.close());

	it("ignores empty journals, user-only turns, machine turns, notices, and failed drafts", () => {
		expect(store.hasNormalAssistantReply()).toBe(false);
		store.appendEntry(
			entry("hello", { role: "user", text: "헬로리나", raw: { id: "hello" } }),
		);
		expect(store.hasNormalAssistantReply()).toBe(false);
		for (const source of [
			entry("tool", { role: "tool" }),
			entry("meta", { role: "meta" }),
			entry("empty", { text: "" }),
			entry("blank", { text: " \t\r\n" }),
			entry("tool-use", { raw: { message: { stopReason: "toolUse" } } }),
			entry("tool-call", {
				raw: {
					message: {
						content: [
							{ type: "text", text: "Working" },
							{ type: "toolCall", name: "read" },
						],
					},
				},
			}),
			entry("phase", { raw: { message: { phase: "commentary" } } }),
			entry("notice", {
				raw: { type: "custom_message", customType: "lina.development" },
			}),
		])
			store.appendEntry(source);
		expect(store.hasNormalAssistantReply()).toBe(false);
		expect(
			store.conversationHistory().messages.some((row) => row.role === "user"),
		).toBe(true);
	});

	it("counts a visible assistant reply and keeps it after later user turns", () => {
		store.appendEntry(entry("hello", { role: "user", text: "헬로리나" }));
		store.appendEntry(
			entry("reply", {
				text: "헬로! 반가워요.",
				raw: {
					type: "message",
					message: {
						role: "assistant",
						phase: null,
						stopReason: "stop",
						content: [{ type: "text", text: "헬로! 반가워요." }],
					},
				},
			}),
		);
		expect(store.hasNormalAssistantReply()).toBe(true);
		store.appendEntry(entry("next", { role: "user", text: "이어서" }));
		expect(store.hasNormalAssistantReply()).toBe(true);
	});
});
