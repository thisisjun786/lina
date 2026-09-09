import type { DatabaseSync } from "node:sqlite";
import { parseAgentVisual, requireVisualRecord } from "./visual-validation.ts";

// Future retained rows: candidate + full profile version + visual version + receipt + authority.
export const AVATAR_CANDIDATE_OUTPUT_RECORDS = 5;
export const AVATAR_APPLICATION_RECORDS = 4;
// A first attempt also retains its candidate-reservation row, including after release.
export const AVATAR_FIRST_ATTEMPT_RECORDS = 1 + AVATAR_CANDIDATE_OUTPUT_RECORDS;
export const AVATAR_ADMISSION_RECORDS = 1 + AVATAR_FIRST_ATTEMPT_RECORDS;

export function visualHistoryUsage(db: DatabaseSync, id: string): number {
	const count = (sql: string) =>
		Number(requireVisualRecord(db.prepare(sql).get(id))["n"]);
	let retained = 0;
	for (const table of [
		"agent_visual_history",
		"agent_visual_profiles",
		"agent_visual_references",
		"agent_visual_grant_history",
		"agent_avatar_admissions",
		"agent_avatar_history",
		"agent_avatar_receipts",
		"agent_avatar_authorities",
		"agent_avatar_candidate_reservations",
	])
		retained += count(`SELECT COUNT(*) n FROM ${table} WHERE agent_id=?`);
	// Physical reservations are immutable dedupe metadata even after unused bytes are released.
	retained += count(
		"SELECT COUNT(*) n FROM agent_avatar_capacity_reservations WHERE json_extract(input_json,'$.owner.agentId')=?",
	);
	const pendingCandidates =
		AVATAR_CANDIDATE_OUTPUT_RECORDS *
		count(
			"SELECT COUNT(*) n FROM agent_avatar_candidate_reservations WHERE agent_id=? AND state='reserved'",
		);
	const pendingApplications =
		AVATAR_APPLICATION_RECORDS *
		count(
			"SELECT COUNT(*) n FROM agent_avatar_history h WHERE agent_id=? AND NOT EXISTS (SELECT 1 FROM agent_avatar_receipts r WHERE r.agent_id=h.agent_id AND r.kind='generated' AND json_extract(r.input_json,'$.candidateId')=h.candidate_id)",
		);
	const firstAttempts =
		AVATAR_FIRST_ATTEMPT_RECORDS *
		count(
			"SELECT COUNT(*) n FROM agent_avatar_admissions a WHERE agent_id=? AND NOT EXISTS (SELECT 1 FROM agent_avatar_candidate_reservations r WHERE r.agent_id=a.agent_id AND r.intent_id=a.intent_id)",
		);
	return retained + pendingCandidates + pendingApplications + firstAttempts;
}
export function requireVisualHistorySpace(
	db: DatabaseSync,
	id: string,
	extra: number,
): void {
	const row = requireVisualRecord(
		db.prepare("SELECT data FROM agent_visuals WHERE agent_id=?").get(id),
	);
	const limit = parseAgentVisual(
		JSON.parse(String(row["data"])),
	).maxHistoryRecords;
	if (limit === null) throw Error("visual history limits not configured");
	if (visualHistoryUsage(db, id) + extra > limit)
		throw Error("visual history capacity reached");
}
