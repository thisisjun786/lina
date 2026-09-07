import { expect, test } from "bun:test";
import { ExecutionModel } from "../../lina-client/src/execution-model.ts";
import type { ControlSnapshot } from "../../lina-core/src/control/types.ts";

const state = (revision = 1): ControlSnapshot => ({
	sessionId: "s",
	revision,
	tools: [],
	approvals: [],
	cancelling: false,
	cancelFailed: false,
	cancelRequestId: "r0",
});
test("cancel uses the authoritative target even when history and tools are empty", () => {
	const model = new ExecutionModel();
	model.receive({ type: "control-state", state: state() }, "s");
	expect(model.cancelCommand()).toEqual({
		type: "cancel",
		sessionId: "s",
		requestId: "r0",
	});
	model.disconnect();
	expect(model.cancelCommand()).toBeUndefined();
});
test("foreign/stale controls are rejected, while a failed cancel permits a scoped retry", () => {
	const model = new ExecutionModel();
	model.receive({ type: "control-state", state: state(3) }, "s");
	model.receive(
		{ type: "control-state", state: { ...state(4), sessionId: "other" } },
		"s",
	);
	model.receive({ type: "control-state", state: state(1) }, "s");
	expect(model.state?.revision).toBe(3);
	model.receive(
		{ type: "control-state", state: { ...state(3), cancelling: true } },
		"s",
	);
	expect(model.cancelCommand()).toBeUndefined();
	model.receive(
		{ type: "control-error", operation: "cancel", message: "not yet stopped" },
		"s",
	);
	expect(model.cancelCommand()).toBeUndefined();
	model.receive(
		{
			type: "control-state",
			state: { ...state(3), cancelling: true, cancelFailed: true },
		},
		"s",
	);
	expect(model.cancelCommand()?.requestId).toBe("r0");
});
test("decisions preserve the displayed digest and cannot address expired approvals", () => {
	const model = new ExecutionModel();
	const approval = {
		id: "a",
		toolRunId: "t",
		state: "pending" as const,
		inputJson: "{}",
		inputDigest: "a".repeat(64),
		expiresAt: Date.now() + 10000,
		createdAt: "now",
	};
	model.receive(
		{ type: "control-state", state: { ...state(), approvals: [approval] } },
		"s",
	);
	expect(model.approvalCommand("a", "allow")).toMatchObject({
		id: "a",
		inputDigest: approval.inputDigest,
		decision: "allow",
	});
	model.receive(
		{
			type: "control-state",
			state: { ...state(2), approvals: [{ ...approval, state: "expired" }] },
		},
		"s",
	);
	expect(model.approvalCommand("a", "allow")).toBeUndefined();
});
