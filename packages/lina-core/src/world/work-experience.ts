import type { LifeStep } from "./autonomy-types.ts";
import type { LifeCommitV3, LifeInput } from "./life-types.ts";
import {
	ownWork,
	workExperienceId,
	workReceiptIdentity,
} from "./work-selection.ts";
import type { WorkEvidenceRecord } from "./work-types.ts";

function resourceRecord(record: WorkEvidenceRecord) {
	return record.source.kind === "resource_activity";
}
function recordFromInput(input: LifeInput): WorkEvidenceRecord | null {
	if (input.version === 2) return { inputId: input.id, source: input.source };
	if (input.version === 4)
		return {
			origin: "resource-activity",
			inputId: input.id,
			source: input.source,
		};
	return null;
}

function inputMatchesRecord(input: LifeInput, record: WorkEvidenceRecord) {
	if (input.id !== record.inputId) return false;
	return resourceRecord(record) ? input.version === 4 : input.version === 2;
}

function priorReceiptInput(input: LifeInput, record: WorkEvidenceRecord) {
	const identity = workReceiptIdentity(record);
	if (resourceRecord(record)) {
		return (
			input.version === 4 &&
			input.source.kind === "resource_activity" &&
			input.source.receipt.activityId === identity.id &&
			input.source.receipt.activityRevision < identity.revision
		);
	}
	return (
		input.version === 2 &&
		input.source.kind === "work" &&
		input.source.receipt.receiptId === identity.id &&
		input.source.receipt.receiptRevision < identity.revision
	);
}

function experienceText(record: WorkEvidenceRecord) {
	const fields = record.source.fields;
	if (fields?.summary) return fields.summary;
	if (record.source.kind === "resource_activity") {
		return record.source.operation === "restrict"
			? "Previously shared resource activity evidence was retracted."
			: `Shared resource activity category: ${fields?.categoryId}. Outcome: ${fields?.outcome ?? "not shared"}.`;
	}
	return record.source.operation === "restrict"
		? "Previously shared work evidence was retracted."
		: `Shared work category: ${fields?.categoryId}. Outcome: ${fields?.outcome ?? "not shared"}.`;
}

function workStep(step: LifeStep) {
	return step.version === 2 || step.version === 3 || step.version === 4;
}

/** Exactly one experience per receipt revision and owner; permission changes only change eligibility. */
export function workExperiences(step: LifeStep): Array<{
	record: WorkEvidenceRecord;
	agentId: string;
	experienceId: string;
	text: string;
}> {
	if (!workStep(step) || !step.source.work) return [];
	const result: Array<{
		record: WorkEvidenceRecord;
		agentId: string;
		experienceId: string;
		text: string;
	}> = [];
	for (const agentId of step.source.pack.life.participants) {
		const records = ownWork(step.source, agentId);
		for (const record of step.source.work.records) {
			if (
				record.source.operation !== "restrict" ||
				record.source.receipt.correction?.kind !== "retract"
			)
				continue;
			const prior = step.source.inputs.filter((input) =>
				priorReceiptInput(input, record),
			);
			if (
				prior.some((input) => {
					const previous = recordFromInput(input);
					return (
						previous !== null &&
						step.source.life.experiences.some(
							(e) => e.id === workExperienceId(step.worldId, previous, agentId),
						)
					);
				})
			)
				records.push(record);
		}
		for (const record of records) {
			if (
				!step.source.inputs.some(
					(input) =>
						inputMatchesRecord(input, record) &&
						input.consumedLifeRevision === null,
				)
			)
				continue;
			const experienceId = workExperienceId(step.worldId, record, agentId);
			if (step.source.life.experiences.some((e) => e.id === experienceId))
				continue;
			result.push({
				record,
				agentId,
				experienceId,
				text: experienceText(record),
			});
		}
	}
	return result;
}
export function applyWorkExperiences(
	step: LifeStep,
	commit: LifeCommitV3,
): void {
	if (!workStep(step)) return;
	const eventId = `${step.worldId}:${step.source.world.revision + 1}`;
	const observations = workExperiences(step);
	if (observations.length && commit.world.kind === "tick") {
		const observer = observations.find((x) =>
			step.source.world.scenes.some((scene) =>
				scene.occupants.includes(x.agentId),
			),
		);
		const scene = step.source.world.scenes.find(
			(scene) => observer && scene.occupants.includes(observer.agentId),
		);
		if (!observer || !scene) return;
		commit.world = {
			...commit.world,
			kind: "activity",
			sceneId: scene.id,
			actorIds: [observer.agentId],
			summary: "Shared work received",
			audience: [...new Set(observations.map((x) => x.agentId))].sort(),
		};
	}
	for (const { record, agentId, experienceId, text } of observations) {
		if (commit.experiences.some((e) => e.id === experienceId)) continue;
		const claimId = `${experienceId}-claim`;
		commit.claims.push({
			id: claimId,
			text,
			sourceEventId: eventId,
			truth: "unknown",
			supersedes: null,
			disclosure: { knowers: [agentId], disclosures: [], publication: [] },
		});
		commit.experiences.push({
			id: experienceId,
			agentId,
			eventId,
			channel: "told",
			claims: [{ kind: "life_claim", id: claimId }],
			simulationTime: step.decision.simulationTime,
		});
		if (
			!commit.consumedInputIds.includes(record.inputId) &&
			step.source.inputs.some(
				(i) => inputMatchesRecord(i, record) && i.consumedLifeRevision === null,
			)
		)
			commit.consumedInputIds.push(record.inputId);
	}
	// Obsolete/restricted deliveries are acknowledged as control history, never reapplied as experience.
	for (const input of step.source.inputs)
		if (
			(input.version === 2 || (step.version === 4 && input.version === 4)) &&
			input.consumedLifeRevision === null &&
			!commit.consumedInputIds.includes(input.id)
		)
			commit.consumedInputIds.push(input.id);
	commit.consumedInputIds.sort();
}
