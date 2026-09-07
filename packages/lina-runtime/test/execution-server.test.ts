import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { startControlServer } from "../src/control-server.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";
import { openFrameClient } from "./socket-client.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	let execution: ExecutionCoordinator;
	const f = createRuntimeFixture({ beforeAbort: () => execution.abortAll() });
	const controls = new ControlStore(
		join(f.root, "control.sqlite"),
		f.runtime.binding,
	);
	execution = new ExecutionCoordinator({
		store: controls,
		gate: new ApprovalGate(controls),
		requestId: () => f.runtime.currentRequestId(),
		runtimeState: () => ({
			cancelling: f.runtime.isCancelling,
			cancelRequestId: f.runtime.cancelRequestId(),
		}),
	});
	const off = f.runtime.subscribe(() => execution.refresh());
	const server = startControlServer({ runtime: f.runtime, execution, port: 0 });
	cleanup.push(async () => {
		await server.stop();
		off();
		await f.runtime.close();
		execution.close();
		controls.close();
		await f.close();
	});
	const peer = await openFrameClient(`ws://127.0.0.1:${server.port}`);
	cleanup.push(async () => peer.close());
	await peer.next();
	return { ...f, execution, controls, peer };
}

test("invalid scoped cancellation is a section error and does not close the conversation", async () => {
	const { peer } = await fixture();
	peer.send({ type: "cancel", sessionId: "foreign", requestId: "r" });
	expect(await peer.next()).toMatchObject({
		type: "control-error",
		operation: "cancel",
	});
	peer.send({ type: "subscribe", version: 2 });
	expect(await peer.until("snapshot")).toMatchObject({
		snapshot: { sessionId: "test-session" },
	});
	expect(await peer.until("control-state")).toMatchObject({
		state: { cancelRequestId: null },
	});
});

test("a wire decision resolves the live matching gate; wrong digest leaves it pending", async () => {
	const { peer, native, runtime, execution, controls } = await fixture();
	native.onPrompt = async (text, admission) => {
		native.emit({ type: "agent_start" });
		native.user("owner", text);
		admission.disposition("started");
	};
	runtime.submit("r", "Write a scoped file");
	execution.begin("call", "write", { path: "test.txt", content: "text" });
	const decision = execution.authorize(
		"call",
		"write",
		{ path: "test.txt", content: "text" },
		new AbortController().signal,
	);
	const approval = controls.snapshot().approvals[0];
	if (!approval) throw new Error("Missing approval");
	peer.send({
		type: "approval_reply",
		sessionId: "test-session",
		id: approval.id,
		inputDigest: "0".repeat(64),
		decision: "allow",
	});
	expect(await peer.until("control-error")).toMatchObject({
		operation: "approval",
	});
	expect(controls.approval(approval.id)?.state).toBe("pending");
	peer.send({
		type: "approval_reply",
		sessionId: "test-session",
		id: approval.id,
		inputDigest: approval.inputDigest,
		decision: "allow",
	});
	expect((await decision).allow).toBe(true);
});
