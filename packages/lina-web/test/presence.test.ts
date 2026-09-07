import { expect, test } from "bun:test";
import type {
	ControlSnapshot,
	ToolRun,
} from "../../lina-core/src/control/types.ts";
import {
	activityStatus,
	elapsedText,
	operationLabel,
} from "../client/presence.ts";

const started = "2026-09-06T01:00:00Z";
const tool: ToolRun = {
	id: "tool",
	nativeCallId: "native",
	requestId: "request",
	name: "edit",
	state: "running",
	inputPreview: JSON.stringify({ path: "/repo/README.md" }),
	outputPreview: "INTERNAL_OUTPUT",
	createdAt: started,
	updatedAt: started,
};
const control: ControlSnapshot = {
	sessionId: "session",
	revision: 1,
	tools: [tool],
	approvals: [],
	cancelRequestId: "request",
	cancelling: false,
	cancelFailed: false,
};
const input = {
	connected: true,
	running: true,
	pending: false,
	requestStartedAt: started,
	control,
	contextBusy: false,
};
test("actual target and operation form a short label, never raw command/output", () => {
	for (const name of [
		"lina_develop_start",
		"lina_develop_status",
		"lina_develop_output",
		"lina_develop_cancel",
	]) {
		expect(operationLabel({ ...tool, name })).toBe("작업 처리 중");
	}
	expect(operationLabel(tool)).toBe("README.md 고치는 중");
	expect(
		operationLabel({
			...tool,
			name: "read",
			inputPreview: '{"path":"/notes/여행.md"}',
		}),
	).toBe("여행.md 읽는 중");
	expect(
		operationLabel({
			...tool,
			name: "bash",
			inputPreview: '{"command":"bun test"}',
		}),
	).toBe("테스트 돌리는 중");
	expect(
		operationLabel({
			...tool,
			name: "bash",
			inputPreview: '{"command":"echo bun test; rm -rf /tmp/test"}',
		}),
	).toBe("작업 처리 중");
	expect(operationLabel({ ...tool, name: "mystery_internal_v1" })).toBe(
		"작업 처리 중",
	);
	expect(operationLabel({ ...tool, inputPreview: "{truncated" })).toBe(
		"파일 고치는 중",
	);
});
test("activity clears finished tools and pauses offline/approval/cancel states", () => {
	expect(activityStatus(input)).toMatchObject({
		label: "README.md 고치는 중",
		moving: true,
		startedAt: started,
	});
	expect(activityStatus({ ...input, connected: false })).toMatchObject({
		label: "연결 끊김",
		moving: false,
	});
	expect(
		activityStatus({ ...input, control: { ...control, cancelling: true } }),
	).toMatchObject({ label: "중단하는 중", moving: false });
	expect(
		activityStatus({
			...input,
			control: { ...control, tools: [{ ...tool, state: "succeeded" }] },
		})?.label,
	).toBe("답변 준비 중");
	expect(
		activityStatus({
			...input,
			control: { ...control, tools: [{ ...tool, requestId: "old" }] },
		})?.label,
	).toBe("답변 준비 중");
	expect(
		activityStatus({ ...input, running: false, control: undefined }),
	).toBeNull();
	expect(
		activityStatus({
			...input,
			control: {
				...control,
				approvals: [
					{
						id: "a",
						toolRunId: "tool",
						inputDigest: "digest",
						inputJson: "{}",
						state: "pending",
						createdAt: started,
						expiresAt: Date.now() + 1000,
					},
				],
			},
		}),
	).toMatchObject({ label: "확인 기다리는 중", moving: false });
});
test("elapsed time derives from durable start, no fabricated zero for unknown clock", () => {
	expect(elapsedText(started, Date.parse(started) + 18000)).toBe("18초");
	expect(elapsedText(started, Date.parse(started) + 72000)).toBe("1분 12초");
	expect(elapsedText(undefined, Date.now())).toBe("");
	expect(elapsedText("bad", Date.now())).toBe("");
	expect(elapsedText(started, Date.parse(started) - 1000)).toBe("");
});
