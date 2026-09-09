import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Type } from "typebox";
import { CodexHost } from "../../lina-codex/src/host.ts";
import {
	ApprovalGate,
	type ControlSnapshot,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import type { PermissionResolver } from "../src/approval-policy.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { installExecutionHooks } from "../src/execution-hooks.ts";
import {
	activity,
	installTestWorldContext as installWorldContext,
	limits,
	worldFixture,
} from "./world-fixture.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(
	permissions: PermissionResolver = () => ({ action: "allow" }),
) {
	const world = worldFixture();
	cleanup.push(world.close);
	const controls = new ControlStore(join(world.root, "control.sqlite"), {
		version: 1,
		botId: "rumi",
		sessionId: "world-approval-session",
		sessionFile: join(world.root, "session.jsonl"),
		workspace: world.root,
	});
	cleanup.push(() => controls.close());
	const execution = new ExecutionCoordinator({
		approvalMode: "confirm",
		store: controls,
		gate: new ApprovalGate(controls),
		requestId: () => "world-read-request",
		runtimeState: () => ({ cancelling: false, cancelRequestId: null }),
	});
	cleanup.push(() => execution.close());
	execution.configurePermissions(permissions);
	const host = new CodexHost(world.root, permissions);
	installExecutionHooks(host.asLinaHost(), execution);
	installWorldContext(host.asLinaHost(), {
		store: world.store,
		worldId: "island",
		agentId: "rumi",
		limits,
	});
	return { world, host, controls, execution };
}

function invoke(f: ReturnType<typeof fixture>, name: string) {
	const controller = new AbortController();
	const assessed = Promise.withResolvers<ControlSnapshot>();
	const off = f.execution.subscribe((state) => {
		const tool = state.tools.find((tool) => tool.nativeCallId === "call-1");
		if (tool && tool.state !== "preparing") assessed.resolve(state);
	});
	const pending = f.host.invokeTool(name, "call-1", {}, controller.signal);
	return {
		pending,
		assessed: Promise.race([
			assessed.promise,
			pending.then(() => f.execution.snapshot()),
		]),
		async close() {
			controller.abort();
			try {
				await pending;
			} finally {
				off();
			}
		},
	};
}

test("confirm-mode world read succeeds without approval and preserves scoped world state", async () => {
	const f = fixture();
	f.world.store.accept(activity());
	const originalWorld = f.world.store.snapshot("island");
	const originalApprovals = f.controls.snapshot().approvals;
	const call = invoke(f, "lina_world_read");
	try {
		const assessed = await call.assessed;
		expect(assessed.tools[0]?.state).toBe("ready");
		expect(assessed.approvals).toEqual(originalApprovals);
		const result = await call.pending;
		expect(result.success).toBe(true);
		const text = result.contentItems.map((item) => item.text).join("\n");
		expect(text).toContain("The boat is red");
		expect(text).toContain('"agentId":"rumi"');
		expect(text).not.toContain("blue key");
		expect(f.controls.snapshot().tools[0]?.state).toBe("succeeded");
		expect(f.controls.snapshot().approvals).toEqual(originalApprovals);
		expect(f.controls.snapshot().approvals).toHaveLength(0);
		expect(f.world.store.snapshot("island")).toEqual(originalWorld);
	} finally {
		// A RED waiting_approval case must settle without waiting for a timeout.
		await call.close();
	}
});

test("confirm mode still requires approval for an untrusted world mutation tool", async () => {
	const f = fixture();
	const originalWorld = f.world.store.snapshot("island");
	let executed = false;
	f.host.asLinaHost().registerTool({
		name: "lina_world_write",
		label: "Test mutation",
		description: "Synthetic mutation tool that must require approval",
		parameters: Type.Object({}),
		execute() {
			executed = true;
			f.world.store.accept(activity());
			return { content: [{ type: "text", text: "mutated" }], details: null };
		},
	});
	const call = invoke(f, "lina_world_write");
	try {
		const state = await call.assessed;
		expect(state.tools[0]?.state).toBe("waiting_approval");
		expect(state.approvals).toHaveLength(1);
		expect(state.approvals[0]?.state).toBe("pending");
		expect(executed).toBe(false);
		expect(f.world.store.snapshot("island")).toEqual(originalWorld);
	} finally {
		await call.close();
	}
	expect((await call.pending).success).toBe(false);
	expect(executed).toBe(false);
	expect(f.world.store.snapshot("island")).toEqual(originalWorld);
});

test.each(["ask", "deny"] as const)(
	"world read still honors explicit native %s policy",
	async (action) => {
		const f = fixture(() => ({ action }));
		const originalWorld = f.world.store.snapshot("island");
		const call = invoke(f, "lina_world_read");
		try {
			const state = await call.assessed;
			expect(state.tools[0]?.state).toBe(
				action === "ask" ? "waiting_approval" : "blocked",
			);
			expect(state.approvals).toHaveLength(action === "ask" ? 1 : 0);
			expect(f.world.store.snapshot("island")).toEqual(originalWorld);
		} finally {
			await call.close();
		}
		expect((await call.pending).success).toBe(false);
	},
);
