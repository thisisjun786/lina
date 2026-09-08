import type { AutonomySource, ReflectionProposal } from "./autonomy-types.ts";
import { finite, identifiers, keyed } from "./life-json.ts";
import type { AgentExperience, GrowthDelta } from "./life-types.ts";

/** Evidence is owned and already observed at this exact staged boundary. */
export function ownedExperienceEvidence(
	source: Pick<AutonomySource, "life" | "world">,
	agentId: string,
	ids: string[],
	minimum = 1,
): AgentExperience[] {
	const checked = identifiers(ids);
	if (checked.length < minimum)
		throw Error("Insufficient distinct experience evidence");
	return checked.map((id) => {
		const row = source.life.experiences.find((x) => x.id === id);
		if (
			!row ||
			row.agentId !== agentId ||
			row.simulationTime > source.world.simulationTime ||
			!row.eventId.startsWith(`${source.world.definition.id}:`) ||
			Number(row.eventId.split(":")[1]) > source.world.revision
		)
			throw Error("Invalid owned experience evidence");
		return row;
	});
}
export function validateReflectionGrowth(
	source: Pick<AutonomySource, "life" | "world" | "pack" | "identity">,
	agentId: string,
	proposals: ReflectionProposal["growth"],
): GrowthDelta[] {
	const policy = source.identity.profiles.find((x) => x.agentId === agentId);
	if (!policy) throw Error("Missing growth identity policy");
	keyed(
		proposals,
		(x) => (x.kind === "trait" ? `trait:${x.axisId}` : `habit:${x.habitId}`),
		false,
	);
	if (policy.evolution === "manual") return [];
	const deltas: GrowthDelta[] = [];
	for (const p of proposals) {
		if (p.kind === "trait") {
			if (policy.lockedTraitIds.includes(p.axisId)) continue;
			const axis = source.pack.life.traits.find((x) => x.id === p.axisId),
				row = source.life.traits.find(
					(x) => x.agentId === agentId && x.axisId === p.axisId,
				);
			if (!axis || !row || finite(p.next) < axis.min || p.next > axis.max)
				throw Error("Invalid growth trait bounds");
			if (
				Math.abs(p.next - row.value) >
				source.pack.autonomy.growth.maxNumericDelta
			)
				throw Error("Growth numeric delta exceeded");
			ownedExperienceEvidence(source, agentId, p.evidenceIds);
			if (
				row.profileRevision !== null &&
				row.profileRevision > policy.profileRevision
			)
				throw Error("Growth identity revision conflict");
			if (row.value !== p.next)
				deltas.push({
					...p,
					agentId,
					previous: row.value,
					evidenceIds: [...p.evidenceIds].sort(),
				});
		} else {
			if (policy.lockedHabitIds.includes(p.habitId)) continue;
			const row = source.life.habits.find(
				(x) => x.agentId === agentId && x.habitId === p.habitId,
			);
			if (!row || typeof p.next !== "boolean")
				throw Error("Unknown growth habit");
			ownedExperienceEvidence(
				source,
				agentId,
				p.evidenceIds,
				source.pack.autonomy.growth.minHabitExperiences,
			);
			if (
				row.profileRevision !== null &&
				row.profileRevision > policy.profileRevision
			)
				throw Error("Growth identity revision conflict");
			if (row.value !== p.next)
				deltas.push({
					...p,
					agentId,
					previous: row.value,
					evidenceIds: [...p.evidenceIds].sort(),
				});
		}
	}
	return deltas;
}
