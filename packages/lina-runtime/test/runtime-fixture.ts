import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../../lina-core/src/index.ts";
import { DurableRuntime } from "../src/runtime.ts";
import type { PromptAdmission, SessionPort } from "../src/sdk-port.ts";

export class ControlledSession implements SessionPort {
	constructor(
		readonly sessionId = "test-session",
		readonly sessionFile = "/tmp/lina-test-session.jsonl",
	) {}
	readonly listeners = new Set<(event: unknown) => void>();
	readonly calls: string[] = [];
	readonly queued: string[] = [];
	clears = 0;
	private activeRun = false;
	hasActiveRun(): boolean {
		return this.activeRun;
	}
	onPrompt: (text: string, admission: PromptAdmission) => Promise<void> =
		async (_text, admission) => {
			admission.disposition("started");
		};
	history(): readonly unknown[] {
		return [];
	}
	subscribe(listener: (event: unknown) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	prompt(text: string, admission: PromptAdmission) {
		this.calls.push(text);
		return this.onPrompt(text, admission);
	}
	emit(event: unknown) {
		if (typeof event === "object" && event !== null && "type" in event) {
			if (event.type === "agent_start") this.activeRun = true;
			if (event.type === "agent_settled") this.activeRun = false;
		}
		for (const listener of this.listeners) listener(event);
	}
	user(id: string, text: string) {
		this.emit({
			type: "entry_appended",
			entry: {
				type: "message",
				id,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text }] },
			},
		});
	}
	async abort() {
		this.emit({ type: "agent_settled" });
	}
	clearQueue() {
		this.clears++;
		this.queued.length = 0;
	}
	async compact() {}
	async appendNotice() {
		return null;
	}
	usage() {
		return { tokens: 0, contextWindow: 200_000 };
	}
	async close() {}
}

export function createRuntimeFixture(
	options: { beforeAbort?: () => void } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "lina-runtime-test-"));
	const native = new ControlledSession();
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: native.sessionId,
		sessionFile: native.sessionFile,
		workspace: root,
	};
	const store = new DurableStore(join(root, "app.sqlite"), binding);
	const runtime = new DurableRuntime(native, store, binding, options);
	return {
		root,
		native,
		store,
		runtime,
		async close() {
			await runtime.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
