import type { LifeStep } from "./autonomy-types.ts";
import {
	array,
	digest,
	enumeration,
	eventReference,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";
import { workExperiences } from "./work-experience.ts";
import { ownWork } from "./work-selection.ts";
import type {
	WorkAncestryRecord,
	WorkEvidenceRecord,
	WorkEvidenceSnapshot,
	WorkSourceRef,
	WorkSubject,
} from "./work-types.ts";

export function parseWorkAncestry(value: unknown): WorkAncestryRecord[] {
	jsonBoundary(value);
	return keyed(
		array(value, (raw) => {
			fields(raw, ["subject", "lifeRevision", "refs"]);
			fields(raw.subject, ["kind", "id"]);
			const kind = enumeration(raw.subject.kind, [
				"world_event",
				"world_scene",
				"world_fact",
				"life_claim",
				"experience",
				"goal",
			]);
			const subject: WorkSubject = {
				kind,
				id:
					kind === "world_event"
						? eventReference(raw.subject.id)
						: identifier(raw.subject.id),
			};
			const refs = keyed(
				array(raw.refs, (r) => {
					fields(r, [
						"inputId",
						"sourceDigest",
						"workConfigDigest",
						"operation",
					]);
					return {
						operation: enumeration(r.operation, ["upsert", "restrict"]),
						inputId: identifier(r.inputId),
						sourceDigest: digest(r.sourceDigest),
						workConfigDigest: digest(r.workConfigDigest),
					};
				}),
				(r) => r.inputId,
			);
			if (!refs.length) throw Error("Empty work ancestry");
			return { subject, lifeRevision: revision(raw.lifeRevision, 1), refs };
		}),
		(r) => `${r.subject.kind}:${r.subject.id}`,
	);
}
export function workRef(
	current: WorkEvidenceSnapshot,
	record: WorkEvidenceRecord,
): WorkSourceRef {
	return {
		operation: record.source.operation,
		inputId: record.inputId,
		sourceDigest: record.source.sourceDigest,
		workConfigDigest: current.workConfigDigest,
	};
}
export function workRefsCurrent(
	current: WorkEvidenceSnapshot,
	refs: WorkSourceRef[],
): boolean {
	return refs.every(
		(ref) =>
			(ref.operation === "restrict" ||
				current.workConfigDigest === ref.workConfigDigest) &&
			current.records.some(
				(record) =>
					record.inputId === ref.inputId &&
					record.source.sourceDigest === ref.sourceDigest &&
					record.source.operation === ref.operation,
			),
	);
}
export function workSubjectAllowed(
	current: WorkEvidenceSnapshot,
	ancestry: WorkAncestryRecord[],
	subject: WorkSubject,
): boolean {
	const row = ancestry.find(
		(r) => r.subject.kind === subject.kind && r.subject.id === subject.id,
	);
	return !row || workRefsCurrent(current, row.refs);
}
/** Conservatively retain the union of work causes available to this step, never expose these refs to models. */
export function stepWorkAncestry(step: LifeStep): WorkAncestryRecord[] {
	const current = step.source.work,
		commit = step.outcome?.commit;
	if (step.version !== 2 || !current || !commit) return [];
	const references = new Map<string, WorkSourceRef>();
	for (const row of step.source.workAncestry ?? [])
		if (workRefsCurrent(current, row.refs))
			for (const ref of row.refs) references.set(ref.inputId, ref);
	for (const agentId of new Set(
		step.models.map((m) => m.prepared.request.agentId),
	))
		for (const record of ownWork(step.source, agentId))
			references.set(record.inputId, workRef(current, record));
	const observations = workExperiences(step);
	for (const { record } of observations)
		references.set(record.inputId, workRef(current, record));
	const refs = [...references.values()].sort((a, b) =>
		a.inputId.localeCompare(b.inputId),
	);
	if (!refs.length) return [];
	const lifeRevision = step.source.life.revision + 1;
	const subjects: WorkSubject[] = [
		{
			kind: "world_event",
			id: `${step.worldId}:${step.source.world.revision + 1}`,
		},
		...commit.world.facts.map((f) => ({
			kind: "world_fact" as const,
			id: f.id,
		})),
		...commit.claims.map((c) => ({ kind: "life_claim" as const, id: c.id })),
		...commit.experiences.map((e) => ({
			kind: "experience" as const,
			id: e.id,
		})),
	];
	if (commit.world.sceneId)
		subjects.push({ kind: "world_scene", id: commit.world.sceneId });
	for (const goal of step.outcome?.nextState.goals ?? [])
		if (goal.lastStepId === step.id)
			subjects.push({ kind: "goal", id: goal.id });
	return subjects.map((subject) => ({ subject, lifeRevision, refs }));
}
export function workAncestryDigest(rows: WorkAncestryRecord[]): string {
	return lifeDigest(rows);
}
