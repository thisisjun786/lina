import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import {
	ApprovalGate,
	type ControlSnapshot,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { ExecutionCoordinator } from "../src/execution.ts";
import { installExecutionHooks } from "../src/execution-hooks.ts";
import { installResourceTools } from "../src/resources/tools.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};

test("resource reads run in confirm mode while writes still wait for approval", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-tools-")),
		store = new ResourceStore(root, limits);
	const controls = new ControlStore(join(root, "controls.sqlite"), {
		version: 1,
		botId: "a",
		sessionId: "test",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	});
	const execution = new ExecutionCoordinator({
		approvalMode: "confirm",
		store: controls,
		gate: new ApprovalGate(controls),
		requestId: () => "request",
		runtimeState: () => ({ cancelling: false, cancelRequestId: null }),
	});
	const permissions = () => ({ action: "allow" as const }),
		host = new CodexHost(root, permissions);
	execution.configurePermissions(permissions);
	installExecutionHooks(host.asLinaHost(), execution);
	installResourceTools(host.asLinaHost(), { store, scope: () => scope });
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("읽기 성공"),
		});
		for (const [name, args] of [
			["lina_resource_read", { id: doc.id }],
			["lina_resource_list", {}],
			["lina_resource_search", { query: "자료" }],
		] as const) {
			const abort = new AbortController(),
				assessed = Promise.withResolvers<ControlSnapshot>();
			const off = execution.subscribe((state) => {
				if (
					state.tools.some(
						(t) => t.nativeCallId === name && t.state !== "preparing",
					)
				)
					assessed.resolve(state);
			});
			const pending = host.invokeTool(name, name, args, abort.signal);
			try {
				const state = await Promise.race([
					assessed.promise,
					pending.then(() => execution.snapshot()),
				]);
				expect(state.approvals).toHaveLength(0);
				expect((await pending).success).toBe(true);
			} finally {
				abort.abort();
				await pending;
				off();
			}
		}
		const abort = new AbortController(),
			assessed = Promise.withResolvers<ControlSnapshot>(),
			off = execution.subscribe((state) => {
				if (state.approvals.length) assessed.resolve(state);
			});
		const pending = host.invokeTool(
			"lina_resource_put",
			"write",
			{
				operationId: "new",
				kind: "collection",
				title: "New",
				visibility: "shared",
			},
			abort.signal,
		);
		try {
			const state = await Promise.race([
				assessed.promise,
				pending.then(() => execution.snapshot()),
			]);
			expect(state.tools.find((t) => t.nativeCallId === "write")?.state).toBe(
				"waiting_approval",
			);
		} finally {
			abort.abort();
			await pending;
			off();
		}
	} finally {
		execution.close();
		controls.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
