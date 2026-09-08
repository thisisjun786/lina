import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { WorldPack } from "./authoring-types.ts";
import {
	buildAutonomyOutcome,
	initialAutonomyState,
} from "./autonomy-transition.ts";
import type { AutonomyState, LifeStep } from "./autonomy-types.ts";
import { parseAutonomyState } from "./autonomy-validation.ts";
import { migrateLifeDefinitionResult } from "./life-definition.ts";
import { identifier, revision } from "./life-json.ts";
import { type CommitRow, decodeLifeEnvelope } from "./life-persistence.ts";
import { applyLifeTransition } from "./life-transition.ts";
import type { LifeState } from "./life-types.ts";
import type { SocialPreparedResolution } from "./social-store-types.ts";
import { transition } from "./transition.ts";
import type { WorldSnapshot } from "./types.ts";

type Source = { world: WorldSnapshot; life: LifeState };
export interface AutonomyHistoryAccess {
	/** Called only for the pre-autonomy baseline, never for an accepted step. */
	sourceAt(worldId: string, lifeRevision: number): Source;
	worldAt(worldId: string, worldRevision: number): WorldSnapshot;
	pack(worldId: string, version: number): WorldPack;
	/** Must decode raw records without calling sourceAt or this history helper. */
	step(worldId: string, stepId: string): LifeStep;
	social(
		worldId: string,
		requestId: string,
		source: Source,
	): SocialPreparedResolution;
}
type BaselineRow = {
	world_id: string;
	base_world_revision: number;
	base_life_revision: number;
	baseline_json: string;
};
function same(actual: unknown, expected: unknown, label: string): void {
	if (!isDeepStrictEqual(actual, expected))
		throw Error(`Corrupt autonomy history ${label}`);
}

/** Rebuilds from accepted ledger entries, including intervening confirmed definitions.
 * Frozen step sources are compared with this result; they never supply the baseline.
 */
export class AutonomyHistory {
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: AutonomyHistoryAccess,
	) {}
	stateAt(worldId: string, lifeRevision: number): AutonomyState | null {
		identifier(worldId);
		revision(lifeRevision);
		if (
			Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) < 5
		)
			return null;
		const row = this.db
			.prepare(
				"SELECT world_id,base_world_revision,base_life_revision,baseline_json FROM life_autonomy_state WHERE world_id=?",
			)
			.get(worldId) as BaselineRow | undefined;
		if (!row) return null;
		revision(row.base_life_revision);
		revision(row.base_world_revision);
		if (lifeRevision < row.base_life_revision) return null;
		const baseline = parseAutonomyState(JSON.parse(row.baseline_json));
		if (
			baseline.worldId !== worldId ||
			baseline.lifeRevision !== row.base_life_revision ||
			baseline.worldRevision !== row.base_world_revision
		)
			throw Error("Corrupt autonomy history baseline boundary");
		// A moved baseline must not hide an earlier autonomous commit or recurse through it.
		for (const raw of this.db
			.prepare(
				"SELECT * FROM life_commits WHERE world_id=? AND life_revision<=? ORDER BY life_revision",
			)
			.iterate(worldId, row.base_life_revision)) {
			const envelope = decodeLifeEnvelope(raw as CommitRow);
			if (
				envelope.version === 1
					? envelope.commit.version === 3
					: envelope.version === 4 && envelope.autonomyMigration !== null
			)
				throw Error("Corrupt autonomy history baseline moved past activation");
		}
		let source = this.access.sourceAt(worldId, row.base_life_revision);
		let pack = this.access.pack(worldId, source.world.definition.version);
		if (
			pack.schemaVersion !== 3 ||
			source.world.revision !== row.base_world_revision ||
			source.life.revision !== row.base_life_revision
		)
			throw Error("Corrupt autonomy history initial source");
		same(
			source.world,
			this.access.worldAt(worldId, row.base_world_revision),
			"baseline world",
		);
		same(
			baseline,
			initialAutonomyState({ ...source, pack }, baseline.seed),
			"baseline state",
		);
		let state = baseline;
		for (const raw of this.db
			.prepare(
				"SELECT * FROM life_commits WHERE world_id=? AND life_revision>? AND life_revision<=? ORDER BY life_revision",
			)
			.iterate(worldId, row.base_life_revision, lifeRevision)) {
			const entry = raw as CommitRow,
				envelope = decodeLifeEnvelope(entry);
			if (
				entry.life_revision !== source.life.revision + 1 ||
				entry.world_revision !== source.world.revision + 1
			)
				throw Error("Corrupt autonomy history revision sequence");
			if (envelope.version !== 1) {
				if (
					envelope.version !== 4 ||
					envelope.fromPackVersion !== pack.version ||
					envelope.expectedLifeRevision !== source.life.revision ||
					envelope.previousDefinitionRevision !== pack.life.revision
				)
					throw Error("Corrupt autonomy history definition source");
				const nextPack = this.access.pack(worldId, envelope.toPackVersion);
				if (nextPack.schemaVersion !== 3)
					throw Error("Autonomy history cannot downgrade");
				const world = transition(source.world, envelope.world);
				same(
					world,
					this.access.worldAt(worldId, entry.world_revision),
					"definition world",
				);
				same(nextPack.life, envelope.definition, "definition pack");
				const migrated = migrateLifeDefinitionResult(
					source.life,
					source.world,
					world,
					pack.life,
					envelope.definition,
					{ old: pack, next: nextPack },
					state,
				);
				same(
					envelope.socialMigration,
					migrated.socialMigration,
					"social migration receipt",
				);
				same(
					envelope.autonomyMigration,
					migrated.autonomyMigration,
					"migration receipt",
				);
				if (!migrated.autonomyState)
					throw Error("Missing autonomy migration state");
				state = migrated.autonomyState;
				source = { world, life: migrated.state };
				pack = nextPack;
				continue;
			}
			const commit = envelope.commit;
			if (commit.version !== 3)
				throw Error("Autonomous history requires a paired step");
			const step = this.access.step(worldId, commit.stepId);
			if (
				step.status !== "accepted" ||
				step.worldId !== worldId ||
				step.id !== commit.stepId ||
				step.receipt?.lifeRevision !== entry.life_revision ||
				step.receipt.worldRevision !== entry.world_revision ||
				step.receipt.inputDigest !== entry.input_digest ||
				step.receipt.replayed !== false
			)
				throw Error("Corrupt autonomy history accepted step");
			same(step.source.world, source.world, "step world source");
			same(step.source.life, source.life, "step LIFE source");
			same(step.source.autonomy, state, "step autonomy source");
			same(step.source.pack, pack, "step pack source");
			same(step.source.identity, envelope.identity, "step identity");
			same(step.receipt.identity, envelope.identity, "receipt identity");
			if (
				step.receipt.worldId !== worldId ||
				step.receipt.eventId !== `${worldId}:${entry.world_revision}`
			)
				throw Error("Corrupt autonomy history step receipt");
			const social =
				step.socialRequestId === null
					? null
					: this.access.social(worldId, step.socialRequestId, source);
			const outcome = buildAutonomyOutcome(step, social);
			same(step.outcome, outcome, "step outcome");
			same(commit, outcome.commit, "step commit");
			const world = transition(source.world, commit.world);
			same(
				world,
				this.access.worldAt(worldId, entry.world_revision),
				"accepted world",
			);
			const life = applyLifeTransition(
				source.life,
				source.world,
				world,
				pack.life,
				commit,
				envelope.identity,
			);
			state = outcome.nextState;
			source = { world, life };
		}
		if (
			source.life.revision !== lifeRevision ||
			state.lifeRevision !== lifeRevision
		)
			throw Error("Missing autonomy history revision");
		return structuredClone(state);
	}
}
