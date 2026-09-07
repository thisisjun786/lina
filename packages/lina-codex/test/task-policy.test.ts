import { expect, test } from "bun:test";
import { threadStartParams } from "../src/tasks/protocol.ts";

test("delegated work pins workspace sandbox and explicit approvals regardless of daemon defaults", () => {
	expect(threadStartParams({ cwd: "/tmp/project" })).toMatchObject({
		sandbox: "workspace-write",
		approvalPolicy: "on-request",
	});
});

test("generic permission profiles are not queued as command approvals", async () => {
	const { isTaskApprovalMethod } = await import("../src/task-rpc.ts");
	expect(isTaskApprovalMethod("item/permissions/requestApproval")).toBe(false);
	expect(isTaskApprovalMethod("item/commandExecution/requestApproval")).toBe(
		true,
	);
});
