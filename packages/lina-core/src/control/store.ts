import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../protocol.ts";
import { openCheckedDatabase, validateBinding } from "../session-binding.ts";
import { validateAuthority } from "./control-json.ts";
import {
	APPROVAL_COLUMNS,
	controlIdentifier,
	visibleControlApprovals,
	visibleControlTools,
} from "./control-records.ts";
import { initializeControl, readRevision } from "./control-schema.ts";
import {
	type Approval,
	type ApprovalState,
	CONTROL_PENDING_LIMIT,
	CONTROL_PREVIEW_MAX_CHARS,
	type ControlSnapshot,
	type ControlStoreOptions,
	type ToolRun,
	type ToolState,
} from "./types.ts";

const transitions: Record<ToolState, readonly ToolState[]> = {
	preparing: ["ready", "failed", "blocked", "interrupted"],
	waiting_approval: [],
	ready: ["running", "succeeded", "failed", "blocked", "interrupted"],
	running: ["succeeded", "failed", "blocked", "interrupted"],
	succeeded: [],
	failed: [],
	blocked: [],
	interrupted: [],
};
const decisionTool: Record<Exclude<ApprovalState, "pending">, ToolState> = {
	allowed: "ready",
	denied: "blocked",
	expired: "blocked",
	aborted: "interrupted",
};

/** Caller holds the app lifetime lease; this store only owns its SQLite handle. */
export class ControlStore {
	private readonly db: DatabaseSync;
	private readonly sessionId: string;
	private readonly now: () => number;
	private closed = false;

	constructor(
		path: string,
		binding: BotBinding,
		options: ControlStoreOptions = {},
	) {
		const identity = validateBinding(binding);
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		this.sessionId = identity.sessionId;
		this.now = options.now ?? Date.now;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			initializeControl(this.db, identity, opened.fresh);
			this.db.exec(
				"COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
			);
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	createTool(
		input: Pick<
			ToolRun,
			"nativeCallId" | "requestId" | "name" | "inputPreview"
		>,
	): ToolRun {
		controlIdentifier(input.nativeCallId);
		controlIdentifier(input.requestId);
		controlIdentifier(input.name);
		return this.mutate(() => {
			const stamp = new Date(this.now()).toISOString();
			const tool: ToolRun = {
				...input,
				id: randomUUID(),
				state: "preparing",
				inputPreview: input.inputPreview.slice(0, CONTROL_PREVIEW_MAX_CHARS),
				outputPreview: "",
				createdAt: stamp,
				updatedAt: stamp,
			};
			this.db
				.prepare("INSERT INTO tools VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					tool.id,
					tool.nativeCallId,
					tool.requestId,
					tool.name,
					tool.state,
					tool.inputPreview,
					tool.outputPreview,
					stamp,
					stamp,
				);
			return tool;
		});
	}

	tool(id: string): ToolRun | undefined {
		// The exact owned SQLite schema fixes this projection.
		return this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as
			| ToolRun
			| undefined;
	}

	setTool(id: string, state: ToolState, outputPreview?: string): ToolRun {
		return this.mutate(() => {
			const current = this.tool(id);
			if (!current) throw new Error("control tool not found");
			const preview =
				outputPreview?.slice(0, CONTROL_PREVIEW_MAX_CHARS) ??
				current.outputPreview;
			if (state === current.state && preview === current.outputPreview)
				return current;
			if (
				!transitions[current.state].length ||
				(state !== current.state && !transitions[current.state].includes(state))
			)
				throw new Error(
					`invalid tool transition: ${current.state} -> ${state}`,
				);
			return this.updateTool(current, state, preview);
		});
	}

	createApproval(
		input: Pick<
			Approval,
			"toolRunId" | "inputDigest" | "inputJson" | "expiresAt"
		>,
	): Approval {
		validateAuthority(input.inputJson, input.inputDigest);
		if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now())
			throw new Error("invalid approval deadline");
		return this.mutate(() => {
			const tool = this.tool(input.toolRunId);
			if (tool?.state !== "preparing") throw new Error("tool is not preparing");
			const count = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM approvals WHERE state = 'pending'",
				)
				.get()?.["count"];
			if (Number(count) >= CONTROL_PENDING_LIMIT)
				throw new Error("approval capacity reached");
			const a: Approval = {
				...input,
				id: randomUUID(),
				state: "pending",
				createdAt: new Date(this.now()).toISOString(),
			};
			this.db
				.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
				.run(
					a.id,
					a.toolRunId,
					a.inputDigest,
					a.inputJson,
					a.state,
					a.expiresAt,
					a.createdAt,
				);
			this.updateTool(tool, "waiting_approval");
			return a;
		});
	}

	approval(id: string): Approval | undefined {
		return this.db
			.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`)
			.get(id) as Approval | undefined;
	}

	decide(
		id: string,
		digest: string,
		state: Exclude<ApprovalState, "pending">,
	): Approval {
		return this.mutate(() => {
			const a = this.approval(id);
			if (
				a?.state !== "pending" ||
				a.inputDigest !== digest ||
				!Object.hasOwn(decisionTool, state)
			)
				throw new Error("invalid approval decision");
			if (state === "allowed" && a.expiresAt <= this.now())
				throw new Error("approval expired");
			const tool = this.tool(a.toolRunId);
			if (tool?.state !== "waiting_approval")
				throw new Error("approval tool is not waiting");
			this.db
				.prepare(
					"UPDATE approvals SET state = ?, decidedRevision = ? WHERE id = ?",
				)
				.run(state, readRevision(this.db) + 1, id);
			this.updateTool(tool, decisionTool[state]);
			return { ...a, state };
		});
	}

	snapshot(
		options: {
			cancelling?: boolean;
			cancelFailed?: boolean;
			cancelRequestId?: string | null;
		} = {},
	): ControlSnapshot {
		if (options.cancelRequestId != null)
			controlIdentifier(options.cancelRequestId);
		return {
			sessionId: this.sessionId,
			revision: readRevision(this.db),
			tools: visibleControlTools(this.db),
			approvals: visibleControlApprovals(this.db),
			cancelling: options.cancelling ?? false,
			cancelFailed: options.cancelFailed ?? false,
			cancelRequestId: options.cancelRequestId ?? null,
		};
	}

	recover(): number {
		return this.mutate(() => {
			const stamp = new Date(this.now()).toISOString();
			const pending = this.db
				.prepare(
					"UPDATE tools SET state = 'blocked', updatedAt = ? WHERE state = 'waiting_approval' AND id IN (SELECT toolRunId FROM approvals WHERE state = 'pending')",
				)
				.run(stamp).changes;
			const decisions = this.db
				.prepare(
					"UPDATE approvals SET state = 'expired', decidedRevision = ? WHERE state = 'pending'",
				)
				.run(readRevision(this.db) + 1).changes;
			const active = this.db
				.prepare(
					"UPDATE tools SET state = 'interrupted', updatedAt = ? WHERE state IN ('preparing','waiting_approval','ready','running')",
				)
				.run(stamp).changes;
			return Number(pending) + Number(decisions) + Number(active);
		});
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private updateTool(
		tool: ToolRun,
		state: ToolState,
		outputPreview = tool.outputPreview,
	): ToolRun {
		const updatedAt = new Date(this.now()).toISOString();
		this.db
			.prepare(
				"UPDATE tools SET state = ?, outputPreview = ?, updatedAt = ? WHERE id = ?",
			)
			.run(state, outputPreview, updatedAt, tool.id);
		return { ...tool, state, outputPreview, updatedAt };
	}

	private mutate<T>(action: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const before = this.db.prepare("SELECT total_changes() AS n").get()?.[
				"n"
			];
			const result = action();
			if (
				before !== this.db.prepare("SELECT total_changes() AS n").get()?.["n"]
			) {
				const revision = readRevision(this.db) + 1;
				if (!Number.isSafeInteger(revision))
					throw new Error("control revision exhausted");
				this.db
					.prepare("UPDATE meta SET value = ? WHERE key = 'revision'")
					.run(String(revision));
			}
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
