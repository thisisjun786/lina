import { canonicalInput } from "./control-json.ts";
import type { ControlStore } from "./store.ts";
import {
	APPROVAL_TTL_MS,
	type Approval,
	type ApprovalGateOptions,
	type ApprovalState,
	type Authorization,
} from "./types.ts";

interface Waiter {
	approval: Approval;
	signal: AbortSignal;
	onAbort: () => void;
	cancel: () => void;
	resolve: (result: Authorization) => void;
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
}

export class ApprovalGate {
	private readonly now: () => number;
	private readonly schedule: NonNullable<ApprovalGateOptions["schedule"]>;
	private readonly waiters = new Map<string, Waiter>();
	private closed = false;
	private epoch = 0;

	constructor(
		private readonly store: ControlStore,
		options: ApprovalGateOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? scheduleTimeout;
	}

	async authorize(
		toolRunId: string,
		input: unknown,
		signal: AbortSignal,
		requiresApproval: boolean,
		ttlMs = APPROVAL_TTL_MS,
	): Promise<Authorization> {
		const tool = this.store.tool(toolRunId);
		if (tool?.state !== "preparing")
			return { allow: false, reason: "tool is missing or already authorized" };
		if (this.closed)
			return this.block(toolRunId, "approval gate is closed", true);
		if (!(signal instanceof AbortSignal))
			return this.block(toolRunId, "tool signal is missing");
		if (signal.aborted) return this.block(toolRunId, "tool aborted", true);
		if (typeof requiresApproval !== "boolean")
			return this.block(toolRunId, "approval policy is missing");
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > APPROVAL_TTL_MS)
			return this.block(toolRunId, "invalid approval deadline");
		const epoch = this.epoch;
		let deadline: number | undefined;
		let original: ReturnType<typeof canonicalInput>;
		try {
			original = canonicalInput(input);
		} catch (error) {
			return this.block(toolRunId, this.reason(error));
		}
		try {
			if (requiresApproval) {
				const approval = this.store.createApproval({
					toolRunId,
					inputDigest: original.digest,
					inputJson: original.json,
					expiresAt: this.now() + ttlMs,
				});
				deadline = approval.expiresAt;
				const decision = await this.wait(approval, signal);
				if (!decision.allow) return decision;
			} else {
				this.store.setTool(toolRunId, "ready");
				// Safe calls share the same final validation boundary as approved calls.
				await Promise.resolve();
			}
			if (signal.aborted || this.closed || epoch !== this.epoch)
				return this.block(toolRunId, "tool aborted", true);
			if (deadline !== undefined && deadline <= this.now())
				return this.block(toolRunId, "approval expired before execution");
			const current = canonicalInput(input);
			if (current.digest !== original.digest || current.json !== original.json)
				return this.block(toolRunId, "approval input changed");
			if (this.store.tool(toolRunId)?.state !== "ready")
				return { allow: false, reason: "tool is no longer ready" };
			return { allow: true };
		} catch (error) {
			return this.block(toolRunId, this.reason(error));
		}
	}

	reply(id: string, digest: string, decision: "allow" | "deny"): boolean {
		const waiter = this.waiters.get(id);
		if (!waiter || this.closed || (decision !== "allow" && decision !== "deny"))
			return false;
		if (digest !== waiter.approval.inputDigest) return false;
		const record = this.store.approval(id);
		if (record?.state !== "pending" || record.inputDigest !== digest) {
			this.settle(
				waiter,
				this.block(waiter.approval.toolRunId, "approval is no longer pending"),
			);
			return false;
		}
		if (waiter.signal.aborted) {
			this.finish(waiter, "aborted");
			return false;
		}
		if (record.expiresAt <= this.now()) {
			this.finish(waiter, "expired");
			return false;
		}
		return this.finish(waiter, decision === "allow" ? "allowed" : "denied");
	}

	abortAll(): void {
		this.epoch++;
		for (const waiter of [...this.waiters.values()])
			this.finish(waiter, "aborted");
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.abortAll();
	}

	private wait(
		approval: Approval,
		signal: AbortSignal,
	): Promise<Authorization> {
		return new Promise((resolve) => {
			const waiter: Waiter = {
				approval,
				signal,
				resolve,
				cancel: () => {},
				onAbort: () => this.finish(waiter, "aborted"),
			};
			this.waiters.set(approval.id, waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			if (signal.aborted) {
				this.finish(waiter, "aborted");
				return;
			}
			try {
				this.arm(waiter);
			} catch (error) {
				this.finish(waiter, "aborted", this.reason(error));
			}
		});
	}

	private arm(waiter: Waiter): void {
		const cancel = this.schedule(
			() => {
				if (!this.waiters.has(waiter.approval.id)) return;
				if (this.now() < waiter.approval.expiresAt) {
					try {
						this.arm(waiter);
					} catch (error) {
						this.finish(waiter, "aborted", this.reason(error));
					}
				} else this.finish(waiter, "expired");
			},
			Math.max(0, waiter.approval.expiresAt - this.now()),
		);
		if (this.waiters.has(waiter.approval.id)) waiter.cancel = cancel;
		else cancel();
	}

	private finish(
		waiter: Waiter,
		state: Exclude<ApprovalState, "pending">,
		reason = `approval ${state}`,
	): boolean {
		if (!this.waiters.has(waiter.approval.id)) return false;
		try {
			this.store.decide(waiter.approval.id, waiter.approval.inputDigest, state);
			this.settle(
				waiter,
				state === "allowed" ? { allow: true } : { allow: false, reason },
			);
			return true;
		} catch (error) {
			this.settle(
				waiter,
				this.block(
					waiter.approval.toolRunId,
					this.reason(error),
					state === "aborted",
				),
			);
			return false;
		}
	}

	private settle(waiter: Waiter, result: Authorization): void {
		this.waiters.delete(waiter.approval.id);
		waiter.cancel();
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(result);
	}

	private block(
		toolRunId: string,
		reason: string,
		interrupted = false,
	): Authorization {
		const tool = this.store.tool(toolRunId);
		if (tool && ["preparing", "ready", "running"].includes(tool.state)) {
			try {
				this.store.setTool(toolRunId, interrupted ? "interrupted" : "blocked");
			} catch (error) {
				return { allow: false, reason: `${reason}; ${this.reason(error)}` };
			}
		}
		return { allow: false, reason };
	}

	private reason(error: unknown): string {
		return error instanceof Error
			? error.message
			: "control authorization failed";
	}
}
