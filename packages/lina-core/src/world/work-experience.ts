import type { LifeStep } from "./autonomy-types.ts";
import type { LifeCommitV3 } from "./life-types.ts";
import { ownWork, workExperienceId } from "./work-selection.ts";
import type { WorkEvidenceRecord } from "./work-types.ts";

/** Exactly one experience per receipt revision and owner; permission changes only change eligibility. */
export function workExperiences(step: LifeStep): Array<{
	record: WorkEvidenceRecord;
	agentId: string;
	experienceId: string;
	text: string;
}> {
	if ((step.version !== 2 && step.version !== 3) || !step.source.work)
		return [];
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
			const prior = step.source.inputs.filter(
				(input) =>
					input.version === 2 &&
					input.source.receipt.receiptId === record.source.receipt.receiptId &&
					input.source.receipt.receiptRevision <
						record.source.receipt.receiptRevision,
			);
			if (
				prior.some(
					(input) =>
						input.version === 2 &&
						step.source.life.experiences.some(
							(e) =>
								e.id ===
								workExperienceId(
									step.worldId,
									{ inputId: input.id, source: input.source },
									agentId,
								),
						),
				)
			)
				records.push(record);
		}
		for (const record of records) {
			if (
				!step.source.inputs.some(
					(input) =>
						input.version === 2 &&
						input.id === record.inputId &&
						input.consumedLifeRevision === null,
				)
			)
				continue;
			const experienceId = workExperienceId(step.worldId, record, agentId);
			if (step.source.life.experiences.some((e) => e.id === experienceId))
				continue;
			const fields = record.source.fields;
			result.push({
				record,
				agentId,
				experienceId,
				text:
					fields?.summary ??
					(record.source.operation === "restrict"
						? "Previously shared work evidence was retracted."
						: `Shared work category: ${fields?.categoryId}. Outcome: ${fields?.outcome ?? "not shared"}.`),
			});
		}
	}
	return result;
}
export function applyWorkExperiences(
	step: LifeStep,
	commit: LifeCommitV3,
): void {
	if (step.version !== 2 && step.version !== 3) return;
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
				(i) => i.id === record.inputId && i.consumedLifeRevision === null,
			)
		)
			commit.consumedInputIds.push(record.inputId);
	}
	// Obsolete/restricted deliveries are acknowledged as control history, never reapplied as experience.
	for (const input of step.source.inputs)
		if (
			input.version === 2 &&
			input.consumedLifeRevision === null &&
			!commit.consumedInputIds.includes(input.id)
		)
			commit.consumedInputIds.push(input.id);
	commit.consumedInputIds.sort();
}
