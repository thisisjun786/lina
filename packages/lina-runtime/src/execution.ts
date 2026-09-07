import type {
	ApprovalGate,
	Authorization,
	ControlSnapshot,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import {
	type ApprovalMode,
	type PermissionResolver,
	parseApprovalMode,
} from "./approval-policy.ts";
import { inputPreview, outputPreview } from "./execution-preview.ts";

const AUTOMATIC = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"lina_notepad_read",
	"lina_attachment_read",
	"lina_status",
	"lina_select_response",
	"lina_memory_query",
	"lina_world_read",
	"lina_world_draft_read",
	"lina_world_draft_preview",
	"lina_life_config_read",
	"lina_history_search",
	"lina_context_expand",
	"lina_develop_status",
	"lina_develop_output",
]);
const TERMINAL = new Set(["succeeded", "failed", "blocked", "interrupted"]);
type Options = {
	approvalMode?: ApprovalMode;
	store: ControlStore;
	gate: ApprovalGate;
	requestId: () => string | undefined;
	runtimeState: () => {
		cancelling: boolean;
		cancelFailed?: boolean;
		cancelRequestId: string | null;
	};
};

export class ExecutionCoordinator {
	private readonly calls = new Map<string, string>();
	private readonly listeners = new Set<(state: ControlSnapshot) => void>();
	private closed = false;
	private permissions: PermissionResolver | undefined;
	private readonly approvalMode: ApprovalMode;
	constructor(private readonly options: Options) {
		this.approvalMode = parseApprovalMode(options.approvalMode ?? "confirm");
	}
	configurePermissions(resolver: PermissionResolver): void {
		if (this.permissions || typeof resolver !== "function")
			throw new Error("Native permissions already configured or invalid");
		this.permissions = resolver;
	}

	begin(nativeCallId: string, name: string, args: unknown): void {
		if (this.closed) return;
		const previous = this.call(nativeCallId);
		if (previous && !TERMINAL.has(previous.state))
			throw new Error("Duplicate active native tool ID");
		const requestId = this.options.requestId();
		if (!requestId) throw new Error("Tool has no active request owner");
		const tool = this.options.store.createTool({
			nativeCallId,
			requestId,
			name,
			inputPreview: inputPreview(args),
		});
		this.calls.set(nativeCallId, tool.id);
		this.publish();
	}

	async authorize(
		nativeCallId: string,
		name: string,
		input: unknown,
		signal: AbortSignal | undefined,
	): Promise<Authorization> {
		if (this.closed)
			return { allow: false, reason: "Execution tracking is closed" };
		const tool = this.call(nativeCallId);
		if (!tool || tool.name !== name || this.closed)
			return {
				allow: false,
				reason: "Tool is not owned by this active request",
			};
		if (!signal) {
			this.options.store.setTool(tool.id, "blocked");
			this.publish();
			return { allow: false, reason: "Native tool signal is missing" };
		}
		let nativeAction: "allow" | "ask" | "deny" = "allow";
		try {
			if (!this.permissions && this.approvalMode === "native")
				throw new Error("Native permission policy unavailable");
			const native = this.permissions?.(name, input);
			if (this.permissions && !native)
				throw new Error("Missing native permission decision");
			nativeAction = native ? native.action : "allow";
			if (
				nativeAction !== "allow" &&
				nativeAction !== "ask" &&
				nativeAction !== "deny"
			)
				throw new Error("Invalid native permission action");
			if (nativeAction === "deny") {
				this.options.store.setTool(tool.id, "blocked");
				this.publish();
				return {
					allow: false,
					reason: native?.reason ?? "Permission denied by the runtime",
				};
			}
		} catch {
			this.options.store.setTool(tool.id, "blocked");
			this.publish();
			return { allow: false, reason: "Native permission evaluation failed" };
		}
		const decision = this.options.gate.authorize(
			tool.id,
			input,
			signal,
			nativeAction === "ask" ||
				(this.approvalMode === "confirm" && !AUTOMATIC.has(name)),
		);
		this.publish();
		try {
			return await decision;
		} finally {
			this.publish();
		}
	}

	update(nativeCallId: string, partial: unknown): void {
		if (this.closed) return;
		const tool = this.call(nativeCallId);
		if (!tool || (tool.state !== "ready" && tool.state !== "running")) return;
		const preview = outputPreview(partial);
		if (tool.state === "running" && tool.outputPreview === preview) return;
		this.options.store.setTool(tool.id, "running", preview);
		this.publish();
	}

	end(nativeCallId: string, result: unknown, isError: boolean): void {
		if (this.closed) return;
		const tool = this.call(nativeCallId);
		if (!tool || TERMINAL.has(tool.state)) return;
		const preview = outputPreview(result);
		if (tool.state === "preparing" && !isError) {
			this.options.store.setTool(
				tool.id,
				"failed",
				"Native tool returned without an authorization boundary",
			);
		} else
			this.options.store.setTool(
				tool.id,
				isError
					? this.options.runtimeState().cancelling
						? "interrupted"
						: "failed"
					: "succeeded",
				preview,
			);
		this.publish();
	}

	reply(id: string, digest: string, decision: "allow" | "deny"): boolean {
		const accepted = this.options.gate.reply(id, digest, decision);
		this.publish();
		return accepted;
	}
	abortAll(): void {
		if (this.closed) return;
		this.options.gate.abortAll();
		this.publish();
	}
	settled(): void {
		if (this.closed) return;
		this.options.gate.abortAll();
		// No native work remains; this also retires an orphan after a failed decision write.
		this.options.store.recover();
		this.calls.clear();
		this.publish();
	}
	snapshot(): ControlSnapshot {
		return this.options.store.snapshot(this.options.runtimeState());
	}
	subscribe(listener: (state: ControlSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	refresh(): void {
		this.publish();
	}
	private call(nativeCallId: string) {
		const id = this.calls.get(nativeCallId);
		return id ? this.options.store.tool(id) : undefined;
	}
	private publish(): void {
		if (!this.closed) {
			const state = this.snapshot();
			for (const listener of this.listeners) listener(state);
		}
	}
	close(): void {
		if (this.closed) return;
		this.options.gate.close();
		this.closed = true;
		this.listeners.clear();
	}
}
