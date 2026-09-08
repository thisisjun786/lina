import type { BehaviorJobInput } from "../../../lina-core/src/agents/behavior-types.ts";
import { behaviorDigest } from "../../../lina-core/src/agents/behavior-validation.ts";
import type { AgentProfile } from "../../../lina-core/src/agents/types.ts";
import type { SourceLookup } from "../../../lina-core/src/source-policy.ts";
import { sourceProofsCurrent } from "../../../lina-core/src/source-policy.ts";
import type { LifeDefinition } from "../../../lina-core/src/world/life-types.ts";
import { contentHash } from "../../../lina-memory/src/engine/reasoning.ts";
import type { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import type { EngineRecord } from "../../../lina-memory/src/engine/types.ts";

export interface PersonalGrowthSource {
	mind: Pick<
		EngineStore,
		"reasoningCandidates" | "currentRecords" | "currentRevision"
	>;
	lookup: SourceLookup;
}
export function growthRecords(source: PersonalGrowthSource): EngineRecord[] {
	return source.mind
		.reasoningCandidates()
		.filter(
			(row) =>
				row.subject === "self" &&
				row.support === "supported" &&
				["interest", "preference"].includes(row.kind),
		);
}
export function growthSourcesCurrent(
	source: PersonalGrowthSource,
	input: BehaviorJobInput,
	profile: AgentProfile,
	definition: LifeDefinition,
): boolean {
	if (
		profile.evolution !== "adaptive" ||
		profile.id !== input.agentId ||
		profile.revision !== input.profileRevision ||
		definition.worldId !== input.worldId ||
		behaviorDigest(definition) !== input.definitionDigest ||
		behaviorDigest(definition.projection) !== input.projectionDigest
	)
		return false;
	const check = () => {
		const current = new Map(growthRecords(source).map((row) => [row.id, row]));
		return input.records.every((ref) => {
			const record = current.get(ref.recordId);
			return (
				!!record &&
				contentHash(record) === ref.contentHash &&
				!!ref.proofs?.length &&
				sourceProofsCurrent(ref.proofs, source.lookup) &&
				!!record.sourceProofs?.length &&
				sourceProofsCurrent(record.sourceProofs, source.lookup) &&
				source.mind.currentRecords([record.id])
			);
		});
	};
	const revision = source.mind.currentRevision();
	return check() && source.mind.currentRevision() === revision && check();
}
