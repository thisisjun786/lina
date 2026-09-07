import { isDeepStrictEqual } from "node:util";
import type { WorldPack } from "./authoring-types.ts";
import { initialLifeState, validateLifeState } from "./life-transition.ts";
import type { LifeDefinition, LifeState } from "./life-types.ts";
import { parseLifeDefinition, parseLifeState } from "./life-validation.ts";
import { migrateSocialCheckpoint } from "./social.ts";
import type { SocialMigrationPreview } from "./social-types.ts";
import type { WorldSnapshot } from "./types.ts";
import { knownAgents } from "./validation.ts";

/** Configuration transitions retain history and initialize only explicitly added dimensions/members. */
export function migrateLifeDefinition(
	previous: LifeState,
	oldWorld: WorldSnapshot,
	nextWorld: WorldSnapshot,
	oldDefinition: LifeDefinition,
	input: LifeDefinition,
	packs?: { old: WorldPack; next: WorldPack },
): LifeState {
	return migrateLifeDefinitionResult(
		previous,
		oldWorld,
		nextWorld,
		oldDefinition,
		input,
		packs,
	).state;
}

export function migrateLifeDefinitionResult(
	previous: LifeState,
	oldWorld: WorldSnapshot,
	nextWorld: WorldSnapshot,
	oldDefinition: LifeDefinition,
	input: LifeDefinition,
	packs?: { old: WorldPack; next: WorldPack },
): { state: LifeState; socialMigration: SocialMigrationPreview | null } {
	const definition = parseLifeDefinition(input);
	validateLifeState(previous, oldWorld, oldDefinition);
	if (
		definition.worldId !== previous.worldId ||
		definition.revision !== oldDefinition.revision + 1 ||
		nextWorld.revision !== oldWorld.revision + 1
	)
		throw Error("LIFE definition revision conflict");
	let checkpoint = previous.checkpoint;
	let socialMigration: SocialMigrationPreview | null = null;
	if (
		packs &&
		(!isDeepStrictEqual(packs.old.world, oldWorld.definition) ||
			!isDeepStrictEqual(packs.next.world, nextWorld.definition) ||
			!isDeepStrictEqual(packs.old.life, oldDefinition) ||
			!isDeepStrictEqual(packs.next.life, definition))
	)
		throw Error("LIFE migration world pack mismatch");
	if (checkpoint.engineId === "ensemble") {
		if (packs?.old.schemaVersion !== 2 || packs.next.schemaVersion !== 2)
			throw Error("No compatible LIFE checkpoint migration");
		const migrated = migrateSocialCheckpoint(
			checkpoint,
			packs.old,
			packs.next,
			{
				worldRevision: nextWorld.revision,
				lifeRevision: previous.revision + 1,
				simulationTime: nextWorld.simulationTime,
			},
		);
		checkpoint = migrated.checkpoint;
		socialMigration = migrated.migration;
	}
	knownAgents(oldDefinition.participants, definition.participants);
	for (const group of ["traits", "habits", "attitudes"] as const)
		for (const old of oldDefinition[group]) {
			const next = definition[group].find((item) => item.id === old.id);
			const { label: _oldLabel, ...oldMeaning } = old;
			if (!next) throw Error("Historical LIFE dimension cannot be removed");
			const { label: _newLabel, ...newMeaning } = next;
			if (!isDeepStrictEqual(oldMeaning, newMeaning))
				throw Error("Historical LIFE baseline cannot be reinterpreted");
		}
	const { revision: oldRevision, ...oldProjection } = oldDefinition.projection;
	const { revision: nextRevision, ...nextProjection } = definition.projection;
	if (
		nextRevision < oldRevision ||
		(!isDeepStrictEqual(oldProjection, nextProjection) &&
			nextRevision !== oldRevision + 1)
	)
		throw Error("LIFE projection revision conflict");
	const baseline = initialLifeState(nextWorld, definition);
	const next = structuredClone(previous);
	next.checkpoint = checkpoint;
	next.revision++;
	next.worldRevision = nextWorld.revision;
	next.definitionRevision = definition.revision;
	for (const row of baseline.traits)
		if (
			!next.traits.some(
				(item) => item.agentId === row.agentId && item.axisId === row.axisId,
			)
		)
			next.traits.push(row);
	for (const row of baseline.habits)
		if (
			!next.habits.some(
				(item) => item.agentId === row.agentId && item.habitId === row.habitId,
			)
		)
			next.habits.push(row);
	for (const row of baseline.attitudes)
		if (
			!next.attitudes.some(
				(item) =>
					item.fromAgentId === row.fromAgentId &&
					item.toAgentId === row.toAgentId &&
					item.axisId === row.axisId,
			)
		)
			next.attitudes.push(row);
	const parsed = parseLifeState(next);
	validateLifeState(parsed, nextWorld, definition);
	return { state: parsed, socialMigration };
}
