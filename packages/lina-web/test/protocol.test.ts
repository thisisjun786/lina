import { describe, expect, it } from "bun:test";
import { parseChat, parseServerFrame } from "../../lina-client/src/protocol.ts";

describe("web protocol", () => {
	for (const frame of [
		{
			type: "job-state",
			sessionId: "session",
			epoch: "retired",
			revision: 1,
			jobs: [],
		},
		{
			type: "job-output",
			sessionId: "session",
			jobId: "job",
			offset: 0,
			text: "Retired execution output",
			nextOffset: null,
		},
		{ type: "job-error", message: "Retired execution error" },
	]) {
		it(`ignores retired ${frame.type} frames`, () => {
			expect(parseServerFrame(JSON.stringify(frame))).toBeUndefined();
		});
	}
	it("preserves correlation when a chat is valid", () => {
		expect(parseChat('{"type":"chat","id":"u1","text":"안녕"}')).toEqual({
			type: "chat",
			id: "u1",
			text: "안녕",
		});
	});
	it("rejects commands when fields or sizes exceed the contract", () => {
		for (const raw of [
			"bad",
			"null",
			'{"type":"chat","id":"1","text":" "}',
			JSON.stringify({
				type: "chat",
				id: "1",
				text: "x",
				url: "http://remote",
			}),
			JSON.stringify({ type: "chat", id: "1", text: "x".repeat(16_001) }),
		]) {
			expect(parseChat(raw)).toBeUndefined();
		}
	});
	it("ignores malformed activity when the source violates the protocol", () => {
		expect(
			parseServerFrame('{"type":"agent-status","state":"done"}'),
		).toBeUndefined();
		expect(parseServerFrame('{"type":"agent-text","text":42}')).toBeUndefined();
		expect(
			parseServerFrame('{"type":"agent-status","state":"running"}'),
		).toEqual({ type: "agent-status", state: "running" });
	});
});
