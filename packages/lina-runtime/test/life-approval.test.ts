import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { CodexHost } from "../../lina-codex/src/host.ts";
import {
	ApprovalGate,
	type ControlSnapshot,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { installExecutionHooks } from "../src/execution-hooks.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(name: string) {
	const root = mkdtempSync(join(tmpdir(), "lina-author-approval-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const store = new ControlStore(join(root, "control.sqlite"), {
		version: 1,
		botId: "lina",
		sessionId: "author-session",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	});
	cleanup.push(() => store.close());
	const execution = new ExecutionCoordinator({
		approvalMode: "confirm",
		store,
		gate: new ApprovalGate(store),
		requestId: () => "author-request",
		runtimeState: () => ({ cancelling: false, cancelRequestId: null }),
	});
	cleanup.push(() => execution.close());
	const host = new CodexHost(root, () => ({ action: "allow" }));
	installExecutionHooks(host, execution);
	let calls = 0;
	host.registerTool({
		name,
		label: "Bound author operation",
		description: "Approval protocol fixture",
		parameters: Type.Object({}),
		execute() {
			calls++;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
	const assessed = Promise.withResolvers<ControlSnapshot>();
	cleanup.push(
		execution.subscribe((snapshot) => {
			if (snapshot.tools[0]?.state !== "preparing") assessed.resolve(snapshot);
		}),
	);
	const controller = new AbortController();
	const result = host.invokeTool(name, "author-call", {}, controller.signal);
	return {
		execution,
		controller,
		result,
		assessed: assessed.promise,
		calls: () => calls,
	};
}

test.each([
	"lina_world_draft_read",
	"lina_world_draft_preview",
	"lina_life_config_read",
])(
	"%s crosses real confirm-mode approval hooks without prompting",
	async (name) => {
		const f = fixture(name);
		try {
			const snapshot = await f.assessed;
			expect(snapshot.tools[0]?.state).toBe("ready");
			expect(snapshot.approvals).toHaveLength(0);
			expect((await f.result).success).toBe(true);
			expect(f.calls()).toBe(1);
		} finally {
			f.controller.abort();
			await f.result;
		}
	},
);

test.each([
	"lina_world_draft_create",
	"lina_world_draft_edit",
	"lina_world_draft_suggest",
	"lina_world_draft_confirm",
	"lina_life_config_update",
])("%s waits for an exact approval digest", async (name) => {
	const f = fixture(name);
	try {
		const snapshot = await f.assessed;
		const approval = snapshot.approvals[0];
		if (!approval) throw Error("Missing author approval");
		expect(snapshot.tools[0]?.state).toBe("waiting_approval");
		expect(f.calls()).toBe(0);
		expect(f.execution.reply(approval.id, "wrong-digest", "allow")).toBe(false);
		expect(f.execution.reply(approval.id, approval.inputDigest, "allow")).toBe(
			true,
		);
		expect((await f.result).success).toBe(true);
		expect(f.calls()).toBe(1);
	} finally {
		f.controller.abort();
		await f.result;
	}
});
