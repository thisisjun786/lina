import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

const cleanup: (() => Promise<void> | undefined)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
	let execution: ExecutionCoordinator;
	const f = createRuntimeFixture({ beforeAbort: () => execution.abortAll() });
	const controls = new ControlStore(
		join(f.root, "control.sqlite"),
		f.runtime.binding,
	);
	const gate = new ApprovalGate(controls);
	execution = new ExecutionCoordinator({
		store: controls,
		gate,
		requestId: () => f.runtime.currentRequestId(),
		runtimeState: () => ({
			cancelling: f.runtime.isCancelling,
			cancelRequestId: f.runtime.cancelRequestId(),
		}),
	});
	cleanup.push(async () => {
		await f.close();
		execution.close();
		controls.close();
	});
	f.native.onPrompt = async (text, admission) => {
		f.native.emit({ type: "agent_start" });
		f.native.user("owner", text);
		admission.disposition("started");
	};
	f.runtime.submit("r", "Perform the scoped work");
	return { ...f, controls, gate, execution };
}

test("native preparation waits for exact permission and denied calls never become successful", async () => {
	const { execution, controls } = fixture();
	execution.begin("native-1", "write", { path: "a", content: "original" });
	expect(controls.snapshot().tools[0]?.state).toBe("preparing");
	const authorization = execution.authorize(
		"native-1",
		"write",
		{ path: "a", content: "validated" },
		new AbortController().signal,
	);
	const approval = controls.snapshot().approvals[0];
	if (!approval) throw new Error("Missing approval");
	expect(approval.inputJson).toContain("validated");
	expect(execution.reply(approval.id, "0".repeat(64), "allow")).toBe(false);
	expect(execution.reply(approval.id, approval.inputDigest, "deny")).toBe(true);
	expect((await authorization).allow).toBe(false);
	execution.end(
		"native-1",
		{ content: [{ type: "text", text: "blocked by hook" }] },
		true,
	);
	expect(controls.snapshot().tools[0]?.state).toBe("blocked");
});

test("safe tools skip a dialog but only actual native updates/end report execution", async () => {
	const { execution, controls } = fixture();
	const signal = new AbortController().signal;
	execution.begin("read-1", "read", { path: "notes.md" });
	expect(
		(await execution.authorize("read-1", "read", { path: "notes.md" }, signal))
			.allow,
	).toBe(true);
	expect(controls.snapshot().tools[0]?.state).toBe("ready");
	execution.update("read-1", {
		content: [{ type: "text", text: "actual partial" }],
	});
	expect(controls.snapshot().tools[0]?.state).toBe("running");
	execution.end(
		"read-1",
		{ content: [{ type: "text", text: "finished" }] },
		false,
	);
	expect(controls.snapshot().tools[0]).toMatchObject({
		state: "succeeded",
		outputPreview: "finished",
	});
	expect(controls.snapshot().approvals).toHaveLength(0);
});

test("bounded context reads do not request mutation approval", async () => {
	const { execution, controls } = fixture();
	for (const name of ["lina_history_search", "lina_context_expand"]) {
		execution.begin(name, name, {});
		const pending = execution.authorize(
			name,
			name,
			{},
			new AbortController().signal,
		);
		try {
			expect(
				controls.snapshot().approvals.filter((a) => a.state === "pending"),
			).toHaveLength(0);
		} finally {
			execution.abortAll();
		}
		await pending;
	}
});

test("validated-input failures and missing owners/signals are blocked honestly", async () => {
	const { execution, controls } = fixture();
	execution.begin("invalid", "write", { content: 17 });
	execution.end(
		"invalid",
		{ content: [{ type: "text", text: "invalid args" }] },
		true,
	);
	expect(controls.snapshot().tools[0]?.state).toBe("failed");
	expect(
		(
			await execution.authorize(
				"unknown",
				"write",
				{},
				new AbortController().signal,
			)
		).allow,
	).toBe(false);
	execution.begin("no-signal", "write", {});
	expect(
		(await execution.authorize("no-signal", "write", {}, undefined)).allow,
	).toBe(false);
});

test("cancelling aborts waiting decisions and preserves the current cancellation target", async () => {
	const { execution, controls, runtime } = fixture();
	execution.begin("pending", "bash", { command: "sleep 30" });
	const decision = execution.authorize(
		"pending",
		"bash",
		{ command: "sleep 30" },
		new AbortController().signal,
	);
	expect(execution.snapshot().cancelRequestId).toBe("r");
	await runtime.cancel("r");
	expect((await decision).allow).toBe(false);
	expect(controls.snapshot().tools[0]?.state).toBe("interrupted");
});

test("a cancelled running tool is interrupted rather than failed", async () => {
	const { execution, controls, runtime, native } = fixture();
	execution.begin("running", "read", { path: "notes.md" });
	await execution.authorize(
		"running",
		"read",
		{ path: "notes.md" },
		new AbortController().signal,
	);
	execution.update("running", { content: [{ type: "text", text: "partial" }] });
	native.abort = async () => {
		execution.end(
			"running",
			{ content: [{ type: "text", text: "Tool execution aborted" }] },
			true,
		);
		native.emit({ type: "agent_settled" });
	};
	await runtime.cancel("r");
	expect(controls.snapshot().tools[0]?.state).toBe("interrupted");
});

test("late native events after close cannot query a closed database", async () => {
	const { execution, controls } = fixture();
	execution.close();
	controls.close();
	expect(() => execution.settled()).not.toThrow();
	expect(() => execution.abortAll()).not.toThrow();
	expect(() => execution.update("late", {})).not.toThrow();
	expect(() => execution.end("late", {}, true)).not.toThrow();
	expect(
		(await execution.authorize("late", "write", {}, undefined)).allow,
	).toBe(false);
});
