import type { DatabaseSync } from "node:sqlite";
import { validateAuthority } from "./control-json.ts";
import {
	type Approval,
	CONTROL_DECISION_LIMIT,
	CONTROL_PENDING_LIMIT,
	CONTROL_PREVIEW_MAX_CHARS,
	CONTROL_TOOL_LIMIT,
	type ToolRun,
	type ToolState,
} from "./types.ts";

export const APPROVAL_COLUMNS =
	"id, toolRunId, inputDigest, inputJson, state, expiresAt, createdAt";

export function visibleControlApprovals(db: DatabaseSync): Approval[] {
	return [
		...db
			.prepare(
				`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE state = 'pending' ORDER BY rowid DESC LIMIT ?`,
			)
			.all(CONTROL_PENDING_LIMIT),
		...db
			.prepare(
				`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE state != 'pending' ORDER BY decidedRevision DESC, rowid DESC LIMIT ?`,
			)
			.all(CONTROL_DECISION_LIMIT),
	] as unknown as Approval[];
}

/** Keep decision subjects present without scanning/sorting the entire tool history. */
export function visibleControlTools(db: DatabaseSync): ToolRun[] {
	const pending = db
		.prepare(
			"SELECT * FROM tools WHERE id IN (SELECT toolRunId FROM approvals WHERE state = 'pending') ORDER BY rowid DESC",
		)
		.all() as unknown as ToolRun[];
	const recent = db
		.prepare("SELECT * FROM tools ORDER BY rowid DESC LIMIT ?")
		.all(CONTROL_TOOL_LIMIT) as unknown as ToolRun[];
	const ids = new Set(pending.map((tool) => tool.id));
	return [...pending, ...recent.filter((tool) => !ids.has(tool.id))].slice(
		0,
		CONTROL_TOOL_LIMIT,
	);
}

export function controlIdentifier(value: string): void {
	if (typeof value !== "string" || !value.trim() || value.length > 128)
		throw new Error("invalid control identifier");
}

function timestamp(value: string): void {
	const time = Date.parse(value);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
		throw new Error("invalid control timestamp");
}

/** Disk rows are a trust boundary even when their table definitions are known. */
export function verifyControlRecords(db: DatabaseSync, revision: number): void {
	for (const row of db.prepare("SELECT * FROM tools").iterate()) {
		const tool = row as unknown as ToolRun;
		for (const id of [tool.id, tool.nativeCallId, tool.requestId, tool.name])
			controlIdentifier(id);
		timestamp(tool.createdAt);
		timestamp(tool.updatedAt);
		if (
			tool.inputPreview.length > CONTROL_PREVIEW_MAX_CHARS ||
			tool.outputPreview.length > CONTROL_PREVIEW_MAX_CHARS
		)
			throw new Error("invalid control preview");
	}
	let pending = 0;
	for (const row of db.prepare("SELECT * FROM approvals").iterate()) {
		const a = row as unknown as Approval;
		controlIdentifier(a.id);
		timestamp(a.createdAt);
		validateAuthority(a.inputJson, a.inputDigest);
		if (
			!Number.isSafeInteger(a.expiresAt) ||
			a.expiresAt <= Date.parse(a.createdAt)
		)
			throw new Error("invalid approval deadline");
		const tool = db
			.prepare("SELECT state FROM tools WHERE id = ?")
			.get(a.toolRunId);
		const states: Record<Approval["state"], readonly ToolState[]> = {
			pending: ["waiting_approval"],
			allowed: [
				"ready",
				"running",
				"succeeded",
				"failed",
				"blocked",
				"interrupted",
			],
			denied: ["blocked"],
			expired: ["blocked"],
			aborted: ["interrupted"],
		};
		if (!tool || !states[a.state].includes(tool["state"] as ToolState))
			throw new Error("invalid approval tool state");
		const decided = row["decidedRevision"];
		if (a.state === "pending") {
			pending++;
			if (decided !== null)
				throw new Error("invalid pending approval revision");
		} else if (
			typeof decided !== "number" ||
			!Number.isSafeInteger(decided) ||
			decided < 1 ||
			decided > revision
		)
			throw new Error("invalid approval decision revision");
	}
	if (pending > CONTROL_PENDING_LIMIT)
		throw new Error("approval capacity exceeded");
	if (
		db
			.prepare(
				"SELECT id FROM tools WHERE state = 'waiting_approval' AND id NOT IN (SELECT toolRunId FROM approvals WHERE state = 'pending') LIMIT 1",
			)
			.get()
	)
		throw new Error("orphan waiting tool");
}
