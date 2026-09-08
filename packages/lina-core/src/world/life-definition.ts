import { isDeepStrictEqual } from "node:util";
import type { WorldPack } from "./authoring-types.ts";
import { migrateAutonomyState } from "./autonomy-migration.ts";
import { assertAutonomyVariables } from "./autonomy-source.ts";
import type {
	AutonomyMigrationPreview,
	AutonomyState,
} from "./autonomy-types.ts";
import { assertLifeEventWeights } from "./events.ts";
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
	autonomy: AutonomyState | null = null,
): {
	state: LifeState;
	socialMigration: SocialMigrationPreview | null;
	autonomyState: AutonomyState | null;
	autonomyMigration: AutonomyMigrationPreview | null;
} {
	const definition = parseLifeDefinition(input);
	validateLifeState(previous, oldWorld, oldDefinition);
	if (
		definition.worldId !== previous.worldId ||
		definition.revision !== oldDefinition.revision + 1 ||
		nextWorld.revision !== oldWorld.revision + 1
	)
		throw Error("LIFE definition revision conflict");
	let autonomyState: AutonomyState | null = null;
	let autonomyMigration: AutonomyMigrationPreview | null = null;
	if (autonomy !== null) {
		if (
			!packs ||
			packs.old.schemaVersion !== 3 ||
			packs.next.schemaVersion !== 3
		)
			throw Error("Active autonomy cannot downgrade its world pack");
		if (
			autonomy.worldRevision !== oldWorld.revision ||
			autonomy.lifeRevision !== previous.revision ||
			autonomy.worldId !== previous.worldId
		)
			throw Error("Stale autonomy migration source");
		assertAutonomyVariables(packs.old, autonomy.variables);
		if (
			previous.checkpoint.engineId === "ensemble" &&
			!isDeepStrictEqual(previous.checkpoint.data.variables, autonomy.variables)
		)
			throw Error("Autonomy migration checkpoint variables disagree");
		const migrated = migrateAutonomyState(autonomy, packs.old, packs.next, {
			worldRevision: nextWorld.revision,
			lifeRevision: previous.revision + 1,
			simulationTime: nextWorld.simulationTime,
		});
		autonomyState = migrated.state;
		autonomyMigration = migrated.migration;
	}
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
		if (
			!packs ||
			packs.old.schemaVersion === 1 ||
			packs.next.schemaVersion === 1
		)
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
	if (
		autonomyState &&
		checkpoint.engineId === "ensemble" &&
		!isDeepStrictEqual(checkpoint.data.variables, autonomyState.variables)
	)
		throw Error("Autonomy migrated checkpoint variables disagree");
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
	if (autonomyState && packs?.next.schemaVersion === 3)
		assertLifeEventWeights({
			pack: packs.next,
			life: parsed,
			autonomy: autonomyState,
		});
	return { state: parsed, socialMigration, autonomyState, autonomyMigration };
}
