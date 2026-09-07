import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import type {
	ApprovalMode,
	PermissionResolver,
} from "../src/approval-policy.ts";
import { ExecutionCoordinator } from "../src/execution.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(mode: ApprovalMode = "native", policy?: PermissionResolver) {
	const root = mkdtempSync("/tmp/lina-native-gate-");
	const store = new ControlStore(join(root, "control.sqlite"), {
		version: 1,
		botId: "lina",
		sessionId: "fixed",
		workspace: root,
		sessionFile: join(root, "native.jsonl"),
	});
	const execution = new ExecutionCoordinator({
		store,
		gate: new ApprovalGate(store),
		approvalMode: mode,
		requestId: () => "request",
		runtimeState: () => ({ cancelling: false, cancelRequestId: "request" }),
	});
	if (policy) execution.configurePermissions(policy);
	cleanup.push(() => {
		execution.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { execution, store };
}
test("native allow removes dialogs while actual execution and cancellation stay tracked", async () => {
	const { execution, store } = fixture("native", () => ({ action: "allow" }));
	for (const name of ["bash", "write", "edit", "lina_develop_start"]) {
		const input = { command: "version" };
		execution.begin(name, name, input);
		const pending = execution.authorize(
			name,
			name,
			input,
			new AbortController().signal,
		);
		expect(store.snapshot().approvals).toHaveLength(0);
		expect((await pending).allow).toBe(true);
		expect(store.snapshot().tools.find((t) => t.name === name)?.state).toBe(
			"ready",
		);
		execution.update(name, { content: [{ type: "text", text: "progress" }] });
		execution.end(name, { content: [{ type: "text", text: "done" }] }, false);
	}
	expect(store.snapshot().tools.every((t) => t.state === "succeeded")).toBe(
		true,
	);
	const input = { command: "before" },
		signal = new AbortController();
	execution.begin("mutate", "bash", input);
	const pending = execution.authorize("mutate", "bash", input, signal.signal);
	input.command = "after";
	expect((await pending).allow).toBe(false);
});
test("native ask retains exact reply/cancel guards and native deny cannot be confirmed away", async () => {
	const { execution, store } = fixture("native", () => ({ action: "ask" }));
	execution.begin("read", "read", { path: "external" });
	const pending = execution.authorize(
		"read",
		"read",
		{ path: "external" },
		new AbortController().signal,
	);
	const approval = store.snapshot().approvals[0];
	expect(approval).toBeDefined();
	if (!approval) throw Error("missing");
	expect(execution.reply(approval.id, "wrong", "allow")).toBe(false);
	execution.abortAll();
	expect((await pending).allow).toBe(false);
	const denied = fixture("confirm", () => ({
		action: "deny",
		reason: "native deny",
	}));
	denied.execution.begin("write", "write", {});
	expect(
		await denied.execution.authorize(
			"write",
			"write",
			{},
			new AbortController().signal,
		),
	).toEqual({ allow: false, reason: "native deny" });
	expect(denied.store.snapshot().approvals).toHaveLength(0);
	expect(denied.store.snapshot().tools[0]?.state).toBe("blocked");
});
test("missing or failing native evaluators block instead of silently allowing", async () => {
	for (const policy of [
		undefined,
		() => {
			throw Error("broken policy");
		},
		(() => undefined) as unknown as PermissionResolver,
		(() => ({})) as unknown as PermissionResolver,
		(async () => ({ action: "allow" })) as unknown as PermissionResolver,
	]) {
		const { execution, store } = fixture("native", policy);
		execution.begin("tool", "bash", {});
		const pending = execution.authorize(
			"tool",
			"bash",
			{},
			new AbortController().signal,
		);
		expect(store.snapshot().tools[0]?.state).toBe("blocked");
		expect((await pending).allow).toBe(false);
		expect(store.snapshot().approvals).toHaveLength(0);
	}
});
