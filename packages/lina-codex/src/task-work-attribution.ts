import type { DatabaseSync } from "node:sqlite";
import type { WorkReceipt } from "./task-work-types.ts";
import {
	workDigest,
	workObject,
	workRevision,
} from "./task-work-validation.ts";
import { field, REQUEST_MAX } from "./tasks/validate.ts";

type SourceRef = { requestId: string; digest: string };
type HandoverRef = { taskRevision: number; digest: string };
type AttributionSources = {
	version: 1;
	inputs: SourceRef[];
	handovers: HandoverRef[];
};
type Attribution = Pick<
	WorkReceipt,
	"ownerAgentId" | "participantAgentIds" | "attributionStatus"
>;
type Row = Record<string, unknown>;

function inputDigest(row: Row): string {
	return workDigest([
		row["request_id"],
		row["task_id"],
		row["owner_agent_id"],
		row["task_revision"],
		row["request_digest"],
		row["target_turn_id"],
		row["prior_turn_ids_json"],
	]);
}
function handoverDigest(row: Row): string {
	return workDigest([
		row["task_id"],
		row["task_revision"],
		row["from_owner"],
		row["to_owner"],
		row["turn_id"],
	]);
}
function parseDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
		throw new Error("invalid work attribution source digest");
	return value;
}
function refs(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 4096)
		throw new Error("invalid work attribution source references");
	return value;
}
function parseSources(value: unknown): AttributionSources {
	const r = workObject(value, ["version", "inputs", "handovers"]);
	if (r["version"] !== 1)
		throw new Error("invalid work attribution source version");
	const inputs = refs(r["inputs"]).map((value) => {
		const r = workObject(value, ["requestId", "digest"]);
		return {
			requestId: field(r["requestId"], "requestId", REQUEST_MAX),
			digest: parseDigest(r["digest"]),
		};
	});
	const handovers = refs(r["handovers"]).map((value) => {
		const r = workObject(value, ["taskRevision", "digest"]);
		return {
			taskRevision: workRevision(r["taskRevision"]),
			digest: parseDigest(r["digest"]),
		};
	});
	if (
		new Set(inputs.map((r) => r.requestId)).size !== inputs.length ||
		new Set(handovers.map((r) => r.taskRevision)).size !== handovers.length
	)
		throw new Error("duplicate work attribution source reference");
	return { version: 1, inputs, handovers };
}
/** Capture only sources that existed when this terminal was first observed. */
export function captureWorkAttribution(
	db: DatabaseSync,
	taskId: string,
	turnId: string,
): AttributionSources {
	const inputs = db
		.prepare(
			"SELECT i.*,r.digest AS request_digest FROM task_work_inputs i JOIN task_requests r ON r.request_id=i.request_id WHERE i.task_id=? AND (i.turn_id=? OR (i.turn_id IS NULL AND i.rejected=0 AND (i.target_turn_id=? OR (i.target_turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(i.prior_turn_ids_json) p WHERE p.value=?))))) ORDER BY i.task_revision,i.rowid",
		)
		.all(taskId, turnId, turnId, turnId);
	const handovers = db
		.prepare(
			"SELECT * FROM task_work_handovers WHERE task_id=? AND turn_id=? ORDER BY task_revision",
		)
		.all(taskId, turnId);
	return parseSources({
		version: 1,
		inputs: inputs.map((r) => ({
			requestId: r["request_id"],
			digest: inputDigest(r),
		})),
		handovers: handovers.map((r) => ({
			taskRevision: r["task_revision"],
			digest: handoverDigest(r),
		})),
	});
}
/** null means an observed terminal is still awaiting exact managed input correlation. */
export function resolveWorkAttribution(
	db: DatabaseSync,
	observation: Row,
): Attribution | null {
	const sources = parseSources(
		JSON.parse(String(observation["attribution_sources_json"])),
	);
	const revision = workRevision(observation["task_revision"], 0);
	const inputs: Row[] = [];
	const unresolved: Row[] = [];
	for (const ref of sources.inputs) {
		const row = db
			.prepare(
				"SELECT i.*,r.digest AS request_digest FROM task_work_inputs i JOIN task_requests r ON r.request_id=i.request_id WHERE i.request_id=?",
			)
			.get(ref.requestId);
		if (
			!row ||
			row["task_id"] !== observation["task_id"] ||
			workRevision(row["task_revision"], 0) > revision ||
			inputDigest(row) !== ref.digest
		)
			throw new Error("work attribution input source mismatch");
		if (row["turn_id"] === null && row["rejected"] === 0) unresolved.push(row);
		else if (row["turn_id"] === observation["turn_id"]) inputs.push(row);
	}
	const participants = new Set(inputs.map((r) => String(r["owner_agent_id"])));
	for (const ref of sources.handovers) {
		const row = db
			.prepare(
				"SELECT * FROM task_work_handovers WHERE task_id=? AND task_revision=?",
			)
			.get(String(observation["task_id"]), ref.taskRevision);
		if (
			!row ||
			row["turn_id"] !== observation["turn_id"] ||
			ref.taskRevision > revision ||
			handoverDigest(row) !== ref.digest
		)
			throw new Error("work attribution handover source mismatch");
		participants.add(String(row["from_owner"]));
		participants.add(String(row["to_owner"]));
	}
	if (
		unresolved.some(
			(row) =>
				row["target_turn_id"] !== null ||
				!inputs.some((input) => input["target_turn_id"] === null),
		)
	)
		return null;
	const ownerAgentId = inputs[0] ? String(inputs[0]["owner_agent_id"]) : null;
	return {
		ownerAgentId,
		participantAgentIds: ownerAgentId === null ? [] : [...participants].sort(),
		attributionStatus: ownerAgentId === null ? "unknown" : "known",
	};
}
