import type { AutonomySource, EventCandidate } from "./autonomy-types.ts";
import { finite, lifeDigest } from "./life-json.ts";
import type { WorkEvidenceRecord, WorkInfluenceRule } from "./work-types.ts";

type Source = Pick<AutonomySource, "work" | "config">;
export function workExperienceId(
	worldId: string,
	record: WorkEvidenceRecord,
	agentId: string,
): string {
	return `work-${lifeDigest([worldId, record.source.receipt.receiptId, record.source.receipt.receiptRevision, agentId]).slice(0, 48)}`;
}
export function workRules(
	source: Source,
	familyId?: string,
): WorkInfluenceRule[] {
	return source.work && source.config.version === 2
		? (source.config.work?.rules ?? []).filter(
				(r) => familyId === undefined || r.familyId === familyId,
			)
		: [];
}
export function matchingWork(
	source: Source,
	rule: WorkInfluenceRule,
	agentId: string,
): WorkEvidenceRecord[] {
	return (source.work?.records ?? []).filter(({ source: record }) => {
		const shared = record.fields,
			receipt = record.receipt;
		return (
			record.operation === "upsert" &&
			shared !== null &&
			receipt.attributionStatus === "known" &&
			shared.categoryId === rule.categoryId &&
			(!rule.outcomes.length ||
				(shared.outcome !== null && rule.outcomes.includes(shared.outcome))) &&
			(rule.attribution === "owner"
				? receipt.ownerAgentId === agentId
				: receipt.participantAgentIds.includes(agentId))
		);
	});
}
export function workContributions(
	source: Source,
	familyId: string,
	agentId: string,
): EventCandidate["contributions"] {
	return workRules(source, familyId).map((rule) => ({
		kind: "work",
		id: rule.id,
		value: finite(matchingWork(source, rule, agentId).length * rule.weight),
	}));
}
export function workEligible(
	source: Source,
	familyId: string,
	agentId: string,
): boolean {
	return workRules(source, familyId).every(
		(rule) =>
			!rule.requiredMatch || matchingWork(source, rule, agentId).length > 0,
	);
}
/** Internal receipt identity remains outside all model envelopes. */
export function ownWork(source: Source, agentId: string): WorkEvidenceRecord[] {
	const allowed = new Set(
		workRules(source).flatMap((rule) =>
			matchingWork(source, rule, agentId).map((r) => r.inputId),
		),
	);
	return (source.work?.records ?? []).filter((record) =>
		allowed.has(record.inputId),
	);
}
export function projectWorkObservations(source: Source, agentId: string) {
	return ownWork(source, agentId).map((record) => {
		const fields = record.source.fields;
		if (!fields) throw Error("Missing permitted work fields");
		return {
			categoryId: fields.categoryId,
			outcome: fields.outcome,
			participantAgentIds: fields.participantAgentIds,
			summary: fields.summary,
			corrected: record.source.receipt.receiptRevision > 1,
		};
	});
}
