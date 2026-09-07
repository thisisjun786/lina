import { describe, expect, test } from "bun:test";
import type { OutboundFrame } from "../src/bridge/frames.ts";
import { createTurnCollector } from "../src/bridge/turn-collector.ts";

const status = (state: "running" | "idle"): OutboundFrame => ({
	type: "agent-status",
	state,
});
const text = (value: string): OutboundFrame => ({
	type: "agent-text",
	text: value,
});

function collector(emitted: string[]): ReturnType<typeof createTurnCollector> {
	return createTurnCollector((value) => emitted.push(value));
}

describe("turn collector", () => {
	test("emits one trimmed turn when running text becomes idle", () => {
		const emitted: string[] = [];
		const target = collector(emitted);

		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("  a  "));
		target.accept(text(" thinking "));
		target.accept(text("  b  "));
		target.accept(status("idle"));

		expect(emitted).toEqual(["a  \n\n thinking \n\n  b"]);
	});

	test("discards partial text when socket closes", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("stale"));
		target.close();
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("fresh"));
		target.accept(status("idle"));

		expect(emitted).toEqual(["fresh"]);
	});

	test("forwards the empty sentinel when a whitespace-only turn completes", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("  \n\t"));
		target.accept(status("idle"));

		expect(emitted).toEqual([""]);
	});

	test("ignores duplicate status frames when status repeats", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("before-duplicate"));
		target.accept(status("running"));
		target.accept(text("once"));
		target.accept(status("idle"));
		target.accept(status("idle"));

		expect(emitted).toEqual(["before-duplicate\n\nonce"]);
	});

	test("ignores acknowledgements errors and thinking frames when received", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept({ type: "ack", id: "1" });
		target.accept({ type: "error", message: "nope" });
		target.accept({ type: "agent-thinking", text: "hmm" });
		target.accept(text("outside"));

		expect(emitted).toEqual([]);
	});

	test("ignores text after close when awaiting fresh idle synchronization", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(status("running"));
		target.close();
		target.accept(text("discarded"));
		target.accept(status("running"));
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("ok"));
		target.accept(status("idle"));

		expect(emitted).toEqual(["ok"]);
	});

	test("emits nothing when fresh running text reaches idle without synchronization", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("running"));
		target.accept(text("half"));
		target.accept(status("idle"));

		expect(emitted).toEqual([]);
	});

	test("preserves frame boundaries when thinking arrives between agent text", () => {
		// Given
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(status("running"));

		// When
		target.accept(text("a"));
		target.accept({ type: "ack", id: "1" });
		target.accept({ type: "error", message: "ignored" });
		target.accept({ type: "agent-thinking", text: "secret" });
		target.accept(text("b"));
		target.accept(status("idle"));

		// Then
		expect(emitted).toEqual(["a\n\nb"]);
	});

	test("resets the buffer when idle text is ignored between back-to-back turns", () => {
		const emitted: string[] = [];
		const target = collector(emitted);
		target.accept(status("idle"));
		target.accept(text("outside"));
		target.accept(status("running"));
		target.accept(text("first"));
		target.accept(status("idle"));
		target.accept(status("running"));
		target.accept(text("second"));
		target.accept(status("idle"));

		expect(emitted).toEqual(["first", "second"]);
	});
});
