import { describe, expect, it } from "bun:test";
import { ChatModel } from "../../lina-client/src/model.ts";

describe("web conversation", () => {
	it("allows only one unresolved request when sending", () => {
		const model = new ChatModel();
		expect(model.send("a", "안녕")).toBe(false);
		model.receive({ type: "agent-status", state: "idle" });
		expect(model.send("a", "안녕")).toBe(true);
		expect(model.send("b", "또 안녕")).toBe(false);
		model.receive({ type: "ack", id: "foreign" });
		expect(model.pendingId).toBe("a");
		model.receive({ type: "ack", id: "a" });
		expect(model.messages[0]?.status).toBe("requested");
		expect(model.messages.some((message) => message.role === "assistant")).toBe(
			false,
		);
	});
	it("joins paragraphs and completes visible output when idle follows text", () => {
		const model = new ChatModel();
		model.receive({ type: "agent-status", state: "running" });
		model.receive({ type: "agent-text", text: "첫 문단" });
		model.receive({ type: "agent-text", text: "두 번째 문단" });
		model.receive({ type: "agent-status", state: "idle" });
		expect(model.messages[0]?.text).toBe("첫 문단\n\n두 번째 문단");
		expect(model.messages[0]?.status).toBe("complete");
	});
	it("keeps interrupted output partial when reconnect reports idle or new text", () => {
		const model = new ChatModel();
		model.receive({ type: "agent-status", state: "running" });
		model.receive({ type: "agent-text", text: "이전" });
		model.disconnect();
		model.receive({ type: "agent-status", state: "idle" });
		expect(model.messages[0]?.status).toBe("partial");
		model.receive({ type: "agent-status", state: "running" });
		model.receive({ type: "agent-text", text: "재연결 이후" });
		expect(model.messages).toHaveLength(2);
		expect(model.messages[0]?.text).toBe("이전");
	});
	it("leaves sends unconfirmed when an unattributed error interrupts the connection", () => {
		const model = new ChatModel();
		model.receive({ type: "agent-status", state: "idle" });
		model.send("a", "잃지 않을 입력");
		model.disconnect();
		expect(model.messages[0]).toMatchObject({
			text: "잃지 않을 입력",
			status: "unconfirmed",
		});
		expect(model.pendingId).toBeUndefined();
		expect(model.send("b", "재요청")).toBe(false);
	});
});
