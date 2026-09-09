import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { WorldPack } from "./authoring-types.ts";
import {
	type AutonomyDefinitionAccess,
	parseAutonomyMigrationPreview,
} from "./autonomy-definition.ts";
import type { AutonomyMigrationPreview } from "./autonomy-types.ts";
import { migrateLifeDefinitionResult } from "./life-definition.ts";
import { canonicalLifeJson, lifeDigest, revision } from "./life-json.ts";
import { parseEffect } from "./life-record-validation.ts";
import {
	applyLifeTransition,
	initialLifeState,
	validateLifeState,
} from "./life-transition.ts";
import type {
	AdmissionReceipt,
	BindingSelection,
	IdentityPolicySnapshot,
	LifeCommit,
	LifeDefinition,
	LifeInput,
	LifePreview,
	LifeReceipt,
	LifeState,
	SideEffectIntent,
	WorldBinding,
} from "./life-types.ts";
import {
	parseIdentityPolicy,
	parseLifeCommit,
	parseLifeDefinition,
	parseLifeInput,
	parseLifeState,
	parseWorldBinding,
} from "./life-validation.ts";
import { parseSocialMigrationPreview } from "./social-receipt-validation.ts";
import type { SocialMigrationPreview } from "./social-types.ts";
import { eventId, transition } from "./transition.ts";
import type {
	WorldDefinitionProposal,
	WorldEvent,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import { fields, id, integer, parseProposal } from "./validation.ts";

type StateRow = {
	world_id: string;
	life_revision: number;
	world_revision: number;
	config_revision: number;
	base_world_revision: number;
	baseline_json: string;
	state_json: string;
};
export type CommitRow = {
	world_id: string;
	life_revision: number;
	world_revision: number;
	idempotency_key: string;
	input_digest: string;
	envelope_json: string;
};
type InputRow = {
	world_id: string;
	input_id: string;
	source_revision: number;
	payload_digest: string;
	input_json: string;
	consumed_life_revision: number | null;
};
type EffectRow = {
	world_id: string;
	intent_id: string;
	life_revision: number;
	payload_digest: string;
	intent_json: string;
	consumer_receipt_json: string | null;
};
const STATE_COLUMNS =
	"world_id, life_revision, world_revision, config_revision, base_world_revision, baseline_json, state_json";
const COMMIT_COLUMNS =
	"world_id, life_revision, world_revision, idempotency_key, input_digest, envelope_json";
const INPUT_COLUMNS =
	"world_id, input_id, source_revision, payload_digest, input_json, consumed_life_revision";
const EFFECT_COLUMNS =
	"world_id, intent_id, life_revision, payload_digest, intent_json, consumer_receipt_json";
type WorldAccess = AutonomyDefinitionAccess & {
	pack(worldId: string, version: number): WorldPack;
	assertSocialCommit(
		commit: LifeCommit,
		identity: IdentityPolicySnapshot,
		source: { world: WorldSnapshot; life: LifeState },
		historical: boolean,
	): void;
	markSocialAccepted(commit: LifeCommit): void;
	assertActors(proposal: WorldProposal): void;
	snapshot(worldId: string): WorldSnapshot;
	snapshotAt(worldId: string, revision: number): WorldSnapshot;
	proposalAt(worldId: string, revision: number): WorldProposal;
	write(proposal: WorldProposal, next: WorldSnapshot): WorldEvent;
};
type Envelope = {
	version: 1;
	commit: LifeCommit;
	identity: IdentityPolicySnapshot;
};
type DefinitionEnvelopeV2 = {
	version: 2;
	kind: "definition";
	world: WorldDefinitionProposal;
	expectedLifeRevision: number;
	previousDefinitionRevision: number;
	definition: LifeDefinition;
};

type DefinitionEnvelopeV3 = Omit<DefinitionEnvelopeV2, "version"> & {
	version: 3;
	fromPackVersion: number;
	toPackVersion: number;
	socialMigration: SocialMigrationPreview | null;
};
type DefinitionEnvelopeV4 = Omit<DefinitionEnvelopeV3, "version"> & {
	version: 4;
	autonomyMigration: AutonomyMigrationPreview | null;
};
export type DefinitionEnvelope =
	| DefinitionEnvelopeV2
	| DefinitionEnvelopeV3
	| DefinitionEnvelopeV4;

export function decodeLifeEnvelope(
	row: CommitRow,
): Envelope | DefinitionEnvelope {
	const value: unknown = JSON.parse(row.envelope_json);
	if (
		value &&
		typeof value === "object" &&
		"version" in value &&
		(value["version"] === 2 || value["version"] === 3 || value["version"] === 4)
	) {
		const social = value["version"] === 3 || value["version"] === 4;
		const autonomous = value["version"] === 4;
		fields(value, [
			"version",
			"kind",
			"world",
			"expectedLifeRevision",
			"previousDefinitionRevision",
			"definition",
			...(autonomous ? (["autonomyMigration"] as const) : []),
			...(social
				? (["fromPackVersion", "toPackVersion", "socialMigration"] as const)
				: []),
		]);
		const world = parseProposal(value["world"]);
		integer(value["expectedLifeRevision"], "previous LIFE revision");
		integer(
			value["previousDefinitionRevision"],
			"previous LIFE definition revision",
			1,
		);
		if (value["kind"] !== "definition" || world.kind !== "definition")
			throw Error("Invalid LIFE configuration envelope");
		const legacy: DefinitionEnvelopeV2 = {
			version: 2,
			kind: "definition",
			world,
			expectedLifeRevision: value["expectedLifeRevision"],
			previousDefinitionRevision: value["previousDefinitionRevision"],
			definition: parseLifeDefinition(value["definition"]),
		};
		const socialEnvelope: DefinitionEnvelopeV2 | DefinitionEnvelopeV3 = social
			? {
					...legacy,
					version: 3,
					fromPackVersion: revision(value["fromPackVersion"], 1),
					toPackVersion: revision(value["toPackVersion"], 1),
					socialMigration:
						value["socialMigration"] === null
							? null
							: parseSocialMigrationPreview(value["socialMigration"]),
				}
			: legacy;
		const envelope: DefinitionEnvelope =
			autonomous && socialEnvelope.version === 3
				? {
						...socialEnvelope,
						version: 4,
						autonomyMigration:
							value["autonomyMigration"] === null
								? null
								: parseAutonomyMigrationPreview(value["autonomyMigration"]),
					}
				: socialEnvelope;
		integer(row.life_revision, "LIFE commit revision", 1);
		integer(row.world_revision, "LIFE world revision", 1);
		if (
			row.world_id !== world.worldId ||
			row.idempotency_key !== world.idempotencyKey ||
			row.life_revision !== envelope.expectedLifeRevision + 1 ||
			row.world_revision !== world.expectedRevision + 1 ||
			row.input_digest !== lifeDigest(envelope)
		)
			throw Error("Corrupt LIFE configuration provenance");
		return envelope;
	}
	fields(value, ["version", "commit", "identity"]);
	if (value["version"] !== 1) throw Error("Unsupported LIFE commit envelope");
	const envelope: Envelope = {
		version: 1,
		commit: parseLifeCommit(value["commit"]),
		identity: parseIdentityPolicy(value["identity"]),
	};
	if (envelope.commit.world.kind === "definition")
		throw Error("Unsupported LIFE configuration in activity envelope");
	integer(row.life_revision, "LIFE commit revision", 1);
	integer(row.world_revision, "LIFE world revision", 1);
	if (
		row.world_id !== envelope.commit.world.worldId ||
		row.idempotency_key !== envelope.commit.world.idempotencyKey ||
		row.life_revision !== envelope.commit.expectedLifeRevision + 1 ||
		row.world_revision !== envelope.commit.world.expectedRevision + 1 ||
		row.input_digest !== lifeDigest(envelope)
	)
		throw Error("Corrupt LIFE commit provenance");
	return envelope;
}
function receipt(row: CommitRow, replayed: boolean): LifeReceipt {
	const envelope = decodeLifeEnvelope(row);
	if (envelope.version !== 1) throw Error("WORLD_CONFIRMATION_REQUIRED");
	return {
		worldId: row.world_id,
		eventId: eventId(row.world_id, row.world_revision),
		worldRevision: row.world_revision,
		lifeRevision: row.life_revision,
		inputDigest: row.input_digest,
		identity: envelope.identity,
		replayed,
	};
}
function decodeInput(row: InputRow): LifeInput {
	const input = parseLifeInput(JSON.parse(row.input_json));
	integer(row.source_revision, "LIFE input source revision");
	if (row.consumed_life_revision !== null)
		integer(row.consumed_life_revision, "LIFE consumed revision", 1);
	if (
		input.worldId !== row.world_id ||
		input.id !== row.input_id ||
		input.sourceRevision !== row.source_revision ||
		input.payloadDigest !== row.payload_digest ||
		input.consumedLifeRevision !== null
	)
		throw Error("Corrupt LIFE input provenance");
	return { ...input, consumedLifeRevision: row.consumed_life_revision };
}
function decodeEffect(row: EffectRow): SideEffectIntent {
	const intent = parseEffect(JSON.parse(row.intent_json));
	integer(row.life_revision, "LIFE effect revision", 1);
	if (
		intent.worldId !== row.world_id ||
		intent.id !== row.intent_id ||
		intent.lifeRevision !== row.life_revision ||
		intent.payloadDigest !== row.payload_digest ||
		row.consumer_receipt_json !== null
	)
		throw Error("Corrupt or unsupported LIFE effect record");
	return intent;
}

/** Internal SQL owner. Every method runs inside WorldStore's existing transaction. */
export class LifePersistence {
	private replayScope = false;
	private replayEpoch: string | undefined;
	private readonly replayStates = new Map<string, LifeState>();
	/** Only unchanged read transactions may share replay results. Writers always clear on exit. */
	setReplayScope(active: boolean, clear = true): void {
		this.replayScope = active;
		if (clear) {
			this.replayEpoch = undefined;
			this.replayStates.clear();
		}
	}
	constructor(
		private readonly db: DatabaseSync,
		private readonly world: WorldAccess,
	) {}
	private row(worldId: string): StateRow | undefined {
		return this.db
			.prepare(`SELECT ${STATE_COLUMNS} FROM life_states WHERE world_id = ?`)
			.get(worldId) as StateRow | undefined;
	}
	prepared(worldId: string): boolean {
		return this.row(worldId) !== undefined;
	}
	definition(worldId: string): LifeDefinition {
		const state = this.row(worldId);
		if (!state) throw Error("LIFE is not prepared for this world");
		return this.config(worldId, state.config_revision);
	}
	definitionAt(worldId: string, lifeRevision: number): LifeDefinition {
		return this.config(
			worldId,
			this.snapshotAt(worldId, lifeRevision).definitionRevision,
		);
	}
	definitionRevision(worldId: string, revision: number): LifeDefinition {
		return this.config(worldId, revision);
	}
	private config(worldId: string, revision: number): LifeDefinition {
		integer(revision, "LIFE configuration revision", 1);
		const row = this.db
			.prepare(
				"SELECT world_id, revision, definition_json, digest FROM life_config WHERE world_id = ? AND revision = ?",
			)
			.get(worldId, revision) as
			| {
					world_id: string;
					revision: number;
					definition_json: string;
					digest: string;
			  }
			| undefined;
		if (!row) throw Error("Missing LIFE configuration");
		const definition = parseLifeDefinition(JSON.parse(row.definition_json));
		if (
			definition.worldId !== row.world_id ||
			definition.revision !== row.revision ||
			row.digest !== lifeDigest(definition)
		)
			throw Error("Corrupt LIFE configuration");
		return definition;
	}
	prepare(definition: LifeDefinition): LifeState {
		const existing = this.row(definition.worldId);
		if (existing) {
			if (!isDeepStrictEqual(this.definition(definition.worldId), definition))
				throw Error("LIFE definition conflict");
			return this.snapshot(definition.worldId);
		}
		const state = initialLifeState(
			this.world.snapshot(definition.worldId),
			definition,
		);
		this.db
			.prepare(
				"INSERT INTO life_config (world_id, revision, definition_json, digest) VALUES (?, ?, ?, ?)",
			)
			.run(
				definition.worldId,
				definition.revision,
				canonicalLifeJson(definition),
				lifeDigest(definition),
			);
		this.db
			.prepare(
				"INSERT INTO life_states (world_id, life_revision, world_revision, config_revision, base_world_revision, baseline_json, state_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				state.worldId,
				0,
				state.worldRevision,
				state.definitionRevision,
				state.baseWorldRevision,
				canonicalLifeJson(state),
				canonicalLifeJson(state),
			);
		return state;
	}
	snapshot(worldId: string): LifeState {
		const row = this.row(worldId);
		if (!row) throw Error("LIFE is not prepared for this world");
		const state = parseLifeState(JSON.parse(row.state_json));
		this.assertStateRow(row, state);
		validateLifeState(
			state,
			this.world.snapshot(worldId),
			this.config(worldId, row.config_revision),
		);
		return state;
	}
	private assertStateRow(row: StateRow, state: LifeState): void {
		for (const number of [
			row.life_revision,
			row.world_revision,
			row.base_world_revision,
		])
			integer(number, "LIFE checkpoint revision");
		integer(row.config_revision, "LIFE configuration revision", 1);
		if (
			state.worldId !== row.world_id ||
			state.revision !== row.life_revision ||
			state.worldRevision !== row.world_revision ||
			state.definitionRevision !== row.config_revision ||
			state.baseWorldRevision !== row.base_world_revision
		)
			throw Error("Corrupt LIFE checkpoint identity");
	}
	legacyWrite(worldId: string, previousRevision?: number): void {
		const state = this.row(worldId);
		if (!state) return;
		if (
			previousRevision !== undefined &&
			previousRevision <= state.base_world_revision
		)
			return;
		throw Error("LIFE_COMMIT_REQUIRED");
	}
	preview(commit: LifeCommit, identity: IdentityPolicySnapshot): LifePreview {
		if (commit.world.kind === "definition")
			throw Error("WORLD_CONFIRMATION_REQUIRED");
		this.world.assertActors(commit.world);
		const previous = this.snapshot(commit.world.worldId);
		const world = this.world.snapshot(commit.world.worldId);
		this.world.assertSocialCommit(
			commit,
			identity,
			{ world, life: previous },
			false,
		);
		const nextWorld = transition(world, commit.world);
		const next = applyLifeTransition(
			previous,
			world,
			nextWorld,
			this.definition(previous.worldId),
			commit,
			identity,
		);
		this.assertExperienceOrigins(commit);
		this.assertInputs(commit, null);
		return { world: nextWorld, life: next };
	}
	private assertExperienceOrigins(commit: LifeCommit): void {
		const currentEvent = eventId(
			commit.world.worldId,
			commit.world.expectedRevision + 1,
		);
		for (const experience of commit.experiences) {
			const event =
				experience.eventId === currentEvent
					? commit.world
					: this.world.proposalAt(
							commit.world.worldId,
							Number(experience.eventId.split(":")[1]),
						);
			if (
				experience.simulationTime !== event.simulationTime ||
				(experience.channel === "direct" &&
					!event.actorIds.includes(experience.agentId)) ||
				(experience.channel === "observed" &&
					!event.audience.includes(experience.agentId))
			)
				throw Error("LIFE experience does not match its accepted event");
		}
	}
	accept(commit: LifeCommit, identity: IdentityPolicySnapshot): LifeReceipt {
		if (commit.world.kind === "definition")
			throw Error("WORLD_CONFIRMATION_REQUIRED");
		const envelope: Envelope = { version: 1, commit, identity };
		const inputDigest = lifeDigest(envelope);
		const previous = this.db
			.prepare(
				`SELECT ${COMMIT_COLUMNS} FROM life_commits WHERE world_id = ? AND idempotency_key = ?`,
			)
			.get(commit.world.worldId, commit.world.idempotencyKey) as
			| CommitRow
			| undefined;
		if (previous) {
			decodeLifeEnvelope(previous);
			if (previous.input_digest !== inputDigest)
				throw Error("LIFE idempotency key conflicts with accepted payload");
			return receipt(previous, true);
		}
		const next = this.preview(commit, identity);
		const accepted = this.world.write(commit.world, next.world);
		const row: CommitRow = {
			world_id: next.life.worldId,
			life_revision: next.life.revision,
			world_revision: accepted.revision,
			idempotency_key: commit.world.idempotencyKey,
			input_digest: inputDigest,
			envelope_json: canonicalLifeJson(envelope),
		};
		this.db
			.prepare(
				"INSERT INTO life_commits (world_id, life_revision, world_revision, idempotency_key, input_digest, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.world_id,
				row.life_revision,
				row.world_revision,
				row.idempotency_key,
				row.input_digest,
				row.envelope_json,
			);
		this.db
			.prepare(
				"UPDATE life_states SET life_revision = ?, world_revision = ?, state_json = ? WHERE world_id = ?",
			)
			.run(
				next.life.revision,
				accepted.revision,
				canonicalLifeJson(next.life),
				next.life.worldId,
			);
		for (const inputId of commit.consumedInputIds) {
			const result = this.db
				.prepare(
					"UPDATE life_inputs SET consumed_life_revision = ? WHERE world_id = ? AND input_id = ? AND consumed_life_revision IS NULL",
				)
				.run(next.life.revision, next.life.worldId, inputId);
			if (result.changes !== 1) throw Error("LIFE input consumption conflict");
		}
		for (const intent of commit.effects)
			this.db
				.prepare(
					"INSERT INTO life_effects (world_id, intent_id, life_revision, payload_digest, intent_json, consumer_receipt_json) VALUES (?, ?, ?, ?, ?, NULL)",
				)
				.run(
					intent.worldId,
					intent.id,
					intent.lifeRevision,
					intent.payloadDigest,
					canonicalLifeJson(intent),
				);
		this.world.markSocialAccepted(commit);
		return receipt(row, false);
	}
	previewDefinition(
		proposal: WorldDefinitionProposal,
		definition: LifeDefinition,
		nextPack?: WorldPack,
	): LifeState {
		return this.previewDefinitionResult(proposal, definition, nextPack).state;
	}
	autonomyStateAt(worldId: string, lifeRevision: number) {
		return this.world.autonomyStateAt(worldId, lifeRevision);
	}
	previewDefinitionResult(
		proposal: WorldDefinitionProposal,
		definition: LifeDefinition,
		nextPack?: WorldPack,
	) {
		const world = this.world.snapshot(proposal.worldId);
		const packs = nextPack
			? {
					old: this.world.pack(proposal.worldId, world.definition.version),
					next: nextPack,
				}
			: undefined;
		const autonomy = this.world.autonomyState(proposal.worldId);
		if (
			autonomy !== null &&
			!isDeepStrictEqual(
				autonomy,
				this.world.autonomyStateAt(proposal.worldId, autonomy.lifeRevision),
			)
		)
			throw Error("Corrupt autonomy migration source history");
		return migrateLifeDefinitionResult(
			this.snapshot(proposal.worldId),
			world,
			transition(world, proposal),
			this.definition(proposal.worldId),
			definition,
			packs,
			autonomy,
		);
	}
	changeDefinition(
		proposal: WorldDefinitionProposal,
		definition: LifeDefinition,
		nextPack?: WorldPack,
	): LifeState {
		const old = this.definition(proposal.worldId),
			migration = this.previewDefinitionResult(proposal, definition, nextPack),
			next = migration.state;
		const legacy: DefinitionEnvelopeV2 = {
			version: 2,
			kind: "definition",
			world: proposal,
			expectedLifeRevision: next.revision - 1,
			previousDefinitionRevision: old.revision,
			definition,
		};
		const socialEnvelope: DefinitionEnvelopeV2 | DefinitionEnvelopeV3 =
			nextPack && nextPack.schemaVersion !== 1
				? {
						...legacy,
						version: 3,
						fromPackVersion: this.world.snapshot(proposal.worldId).definition
							.version,
						toPackVersion: nextPack.version,
						socialMigration: migration.socialMigration,
					}
				: legacy;
		const envelope: DefinitionEnvelope =
			nextPack?.schemaVersion === 3 && socialEnvelope.version === 3
				? {
						...socialEnvelope,
						version: 4,
						autonomyMigration: migration.autonomyMigration,
					}
				: socialEnvelope;
		this.db
			.prepare(
				"INSERT INTO life_config (world_id, revision, definition_json, digest) VALUES (?, ?, ?, ?)",
			)
			.run(
				definition.worldId,
				definition.revision,
				canonicalLifeJson(definition),
				lifeDigest(definition),
			);
		const accepted = this.world.write(
			proposal,
			transition(this.world.snapshot(proposal.worldId), proposal),
		);
		this.db
			.prepare(
				"INSERT INTO life_commits (world_id, life_revision, world_revision, idempotency_key, input_digest, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				proposal.worldId,
				next.revision,
				accepted.revision,
				proposal.idempotencyKey,
				lifeDigest(envelope),
				canonicalLifeJson(envelope),
			);
		this.db
			.prepare(
				"UPDATE life_states SET life_revision = ?, world_revision = ?, config_revision = ?, state_json = ? WHERE world_id = ?",
			)
			.run(
				next.revision,
				accepted.revision,
				definition.revision,
				canonicalLifeJson(next),
				proposal.worldId,
			);
		for (const row of this.db
			.prepare("SELECT policy_json FROM world_bindings WHERE world_id = ?")
			.all(proposal.worldId) as Array<{ policy_json: string }>) {
			const previous = parseWorldBinding(JSON.parse(row.policy_json));
			const binding = parseWorldBinding({
				...previous,
				revision: previous.revision + 1,
				projectionPolicyRevision: definition.projection.revision,
			});
			this.db
				.prepare(
					"UPDATE world_bindings SET revision = ?, policy_json = ? WHERE agent_id = ?",
				)
				.run(binding.revision, canonicalLifeJson(binding), binding.agentId);
		}
		if (migration.autonomyState)
			this.world.saveAutonomyState(migration.autonomyState);
		return next;
	}
	private assertInputs(
		commit: LifeCommit,
		consumedRevision: number | null,
	): void {
		for (const inputId of commit.consumedInputIds) {
			const row = this.db
				.prepare(
					`SELECT ${INPUT_COLUMNS} FROM life_inputs WHERE world_id = ? AND input_id = ?`,
				)
				.get(commit.world.worldId, inputId) as InputRow | undefined;
			if (!row || decodeInput(row).consumedLifeRevision !== consumedRevision)
				throw Error("Missing or already consumed LIFE input");
		}
	}
	admit(input: LifeInput): AdmissionReceipt {
		if (input.consumedLifeRevision !== null)
			throw Error("A new LIFE input cannot be marked consumed");
		this.world.snapshot(input.worldId);
		const row = this.db
			.prepare(
				`SELECT ${INPUT_COLUMNS} FROM life_inputs WHERE world_id = ? AND input_id = ?`,
			)
			.get(input.worldId, input.id) as InputRow | undefined;
		if (row) {
			const previous = { ...decodeInput(row), consumedLifeRevision: null };
			if (!isDeepStrictEqual(previous, input))
				throw Error("LIFE input conflict");
		} else
			this.db
				.prepare(
					"INSERT INTO life_inputs (world_id, input_id, source_revision, payload_digest, input_json, consumed_life_revision) VALUES (?, ?, ?, ?, ?, NULL)",
				)
				.run(
					input.worldId,
					input.id,
					input.sourceRevision,
					input.payloadDigest,
					canonicalLifeJson(input),
				);
		return {
			worldId: input.worldId,
			inputId: input.id,
			payloadDigest: input.payloadDigest,
			replayed: !!row,
		};
	}
	inputs(worldId: string): LifeInput[] {
		this.world.snapshot(worldId);
		return (
			this.db
				.prepare(
					`SELECT ${INPUT_COLUMNS} FROM life_inputs WHERE world_id = ? ORDER BY input_id`,
				)
				.all(worldId) as InputRow[]
		).map(decodeInput);
	}
	effects(worldId: string): SideEffectIntent[] {
		this.world.snapshot(worldId);
		return (
			this.db
				.prepare(
					`SELECT ${EFFECT_COLUMNS} FROM life_effects WHERE world_id = ? ORDER BY life_revision, intent_id`,
				)
				.all(worldId) as EffectRow[]
		).map(decodeEffect);
	}

	invalidateBindings(worldId: string): void {
		for (const row of this.db
			.prepare(
				"SELECT agent_id,policy_json FROM world_bindings WHERE world_id=?",
			)
			.all(worldId)) {
			const current = parseWorldBinding(JSON.parse(String(row["policy_json"])));
			const next = parseWorldBinding({
				...current,
				revision: current.revision + 1,
			});
			this.db
				.prepare(
					"UPDATE world_bindings SET revision=?,policy_json=? WHERE agent_id=?",
				)
				.run(next.revision, canonicalLifeJson(next), next.agentId);
		}
	}
	binding(agentId: string): WorldBinding | null {
		const row = this.db
			.prepare(
				"SELECT agent_id, world_id, revision, policy_json FROM world_bindings WHERE agent_id = ?",
			)
			.get(agentId) as
			| {
					agent_id: string;
					world_id: string | null;
					revision: number;
					policy_json: string;
			  }
			| undefined;
		if (!row) return null;
		const binding = parseWorldBinding(JSON.parse(row.policy_json));
		if (
			binding.agentId !== row.agent_id ||
			binding.worldId !== row.world_id ||
			binding.revision !== row.revision
		)
			throw Error("Corrupt LIFE world binding");
		this.assertSelection(agentId, binding);
		return binding;
	}
	private assertSelection(agentId: string, selection: BindingSelection): void {
		if (selection.worldId === null) return;
		const definition = this.definition(selection.worldId);
		if (
			!definition.participants.includes(agentId) ||
			selection.projectionPolicyRevision !== definition.projection.revision
		)
			throw Error("Invalid LIFE world binding selection");
	}
	bind(
		agentId: string,
		expectedRevision: number,
		selection: BindingSelection,
	): WorldBinding {
		const previous = this.binding(agentId);
		if ((previous?.revision ?? 0) !== expectedRevision)
			throw Error("LIFE binding revision conflict");
		this.assertSelection(agentId, selection);
		const binding = parseWorldBinding({
			version: 1,
			agentId,
			...selection,
			revision: expectedRevision + 1,
		});
		this.db
			.prepare(
				"INSERT INTO world_bindings (agent_id, world_id, revision, policy_json) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET world_id = excluded.world_id, revision = excluded.revision, policy_json = excluded.policy_json",
			)
			.run(
				agentId,
				selection.worldId,
				binding.revision,
				canonicalLifeJson(binding),
			);
		return binding;
	}
	snapshotAt(worldId: string, revision: number): LifeState {
		const row = this.row(worldId);
		if (!row || revision > row.life_revision)
			throw Error("Unknown LIFE revision");
		const key = JSON.stringify([worldId, revision]);
		if (this.replayScope) {
			// row() established the read snapshot. data_version detects external
			// commits; total_changes detects local writes within the current transaction.
			const epoch = JSON.stringify(
				this.db
					.prepare(
						"SELECT data_version, total_changes() AS writes FROM pragma_data_version",
					)
					.get(),
			);
			if (epoch !== this.replayEpoch) {
				this.replayStates.clear();
				this.replayEpoch = epoch;
			}
			const cached = this.replayStates.get(key);
			if (cached) return structuredClone(cached);
		}
		const state = this.rebuild(row, revision).state;
		if (this.replayScope) {
			// Bound memory independently of the configured world's history length.
			if (this.replayStates.size >= 16) this.replayStates.clear();
			this.replayStates.set(key, structuredClone(state));
		}
		return state;
	}
	/** Immutable paired commit and receipt used by trusted publication provenance checks. */
	commitAt(worldId: string, lifeRevision: number) {
		id(worldId);
		revision(lifeRevision, 1);
		const row = this.db
			.prepare(
				`SELECT ${COMMIT_COLUMNS} FROM life_commits WHERE world_id=? AND life_revision=?`,
			)
			.get(worldId, lifeRevision) as CommitRow | undefined;
		if (!row) throw Error("Missing LIFE commit history");
		const envelope = decodeLifeEnvelope(row);
		return {
			envelope,
			receipt: envelope.version === 1 ? receipt(row, false) : null,
		};
	}
	private rebuild(row: StateRow, revision?: number) {
		let state = parseLifeState(JSON.parse(row.baseline_json));
		let definition = this.config(row.world_id, state.definitionRevision);
		const configs = new Set([definition.revision]);
		const baseline = initialLifeState(
			this.world.snapshotAt(row.world_id, row.base_world_revision),
			definition,
		);
		if (!isDeepStrictEqual(state, baseline))
			throw Error("Corrupt LIFE baseline");
		const effects = new Map<string, SideEffectIntent>();
		const consumed = new Map<string, number>();
		const query = this.db.prepare(
			`SELECT ${COMMIT_COLUMNS} FROM life_commits WHERE world_id = ?${revision === undefined ? "" : " AND life_revision <= ?"} ORDER BY life_revision`,
		);
		const rows =
			revision === undefined
				? query.iterate(row.world_id)
				: query.iterate(row.world_id, revision);
		for (const raw of rows) {
			const entry = raw as CommitRow;
			const envelope = decodeLifeEnvelope(entry);
			const oldWorld = this.world.snapshotAt(row.world_id, state.worldRevision);
			const nextWorld = this.world.snapshotAt(
				row.world_id,
				entry.world_revision,
			);
			if (envelope.version !== 1) {
				if (
					!isDeepStrictEqual(
						envelope.world,
						this.world.proposalAt(row.world_id, entry.world_revision),
					) ||
					envelope.expectedLifeRevision !== state.revision ||
					envelope.previousDefinitionRevision !== definition.revision ||
					!isDeepStrictEqual(
						envelope.definition,
						this.config(row.world_id, envelope.definition.revision),
					)
				)
					throw Error("Corrupt paired LIFE configuration event");
				const packs =
					envelope.version !== 2
						? {
								old: this.world.pack(row.world_id, envelope.fromPackVersion),
								next: this.world.pack(row.world_id, envelope.toPackVersion),
							}
						: undefined;
				const migration = migrateLifeDefinitionResult(
					state,
					oldWorld,
					nextWorld,
					definition,
					envelope.definition,
					packs,
					this.world.autonomyStateAt(row.world_id, state.revision),
				);
				if (
					envelope.version !== 2 &&
					(envelope.fromPackVersion !== oldWorld.definition.version ||
						envelope.toPackVersion !== nextWorld.definition.version ||
						!isDeepStrictEqual(
							envelope.socialMigration,
							migration.socialMigration,
						))
				)
					throw Error("Corrupt LIFE social migration receipt");
				if (
					envelope.version === 4
						? !isDeepStrictEqual(
								envelope.autonomyMigration,
								migration.autonomyMigration,
							)
						: migration.autonomyMigration !== null
				)
					throw Error("Corrupt LIFE autonomy migration receipt");
				state = migration.state;
				definition = envelope.definition;
				configs.add(definition.revision);
				if (
					state.revision !== entry.life_revision ||
					state.worldRevision !== entry.world_revision
				)
					throw Error("Corrupt LIFE configuration revision sequence");
				continue;
			}
			if (
				!isDeepStrictEqual(
					envelope.commit.world,
					this.world.proposalAt(row.world_id, entry.world_revision),
				)
			)
				throw Error("Corrupt paired LIFE event");
			this.world.assertSocialCommit(
				envelope.commit,
				envelope.identity,
				{ world: oldWorld, life: state },
				true,
			);
			state = applyLifeTransition(
				state,
				oldWorld,
				nextWorld,
				definition,
				envelope.commit,
				envelope.identity,
			);
			this.assertExperienceOrigins(envelope.commit);
			if (
				state.revision !== entry.life_revision ||
				state.worldRevision !== entry.world_revision
			)
				throw Error("Corrupt LIFE revision sequence");
			this.assertInputs(envelope.commit, state.revision);
			for (const inputId of envelope.commit.consumedInputIds) {
				if (consumed.has(inputId))
					throw Error("Duplicate LIFE input consumption");
				consumed.set(inputId, state.revision);
			}
			for (const intent of envelope.commit.effects) {
				if (effects.has(intent.id)) throw Error("Duplicate LIFE effect intent");
				effects.set(intent.id, intent);
			}
		}
		if (revision !== undefined && state.revision !== revision)
			throw Error("Missing LIFE revision");
		return { state, effects, consumed, configs };
	}
	/** Audit all rows without a safe-integer upper filter, before any model or query consumer. */
	audit(): void {
		const states = this.db
			.prepare(`SELECT ${STATE_COLUMNS} FROM life_states`)
			.all() as StateRow[];
		const configs = this.db
			.prepare("SELECT world_id, revision FROM life_config")
			.all() as Array<{ world_id: string; revision: number }>;
		for (const config of configs) {
			this.config(config.world_id, config.revision);
			if (!states.some((row) => row.world_id === config.world_id))
				throw Error("Orphan LIFE configuration");
		}
		for (const row of states) {
			const saved = this.snapshot(row.world_id);
			const rebuilt = this.rebuild(row);
			const registered = configs.filter(
				(item) => item.world_id === row.world_id,
			);
			if (
				registered.length !== rebuilt.configs.size ||
				registered.some((item) => !rebuilt.configs.has(item.revision))
			)
				throw Error("Orphan LIFE configuration");
			if (!isDeepStrictEqual(saved, rebuilt.state))
				throw Error("Corrupt LIFE checkpoint");
			const effects = this.effects(row.world_id);
			if (
				effects.length !== rebuilt.effects.size ||
				effects.some(
					(intent) =>
						!isDeepStrictEqual(intent, rebuilt.effects.get(intent.id)),
				)
			)
				throw Error("Corrupt LIFE effect ledger");
			for (const input of this.inputs(row.world_id)) {
				if (
					input.consumedLifeRevision !==
					(rebuilt.consumed.get(input.id) ?? null)
				)
					throw Error("Corrupt LIFE input consumption");
			}
		}
		// Unconsumed inputs are allowed before explicit preparation; still validate every row.
		for (const raw of this.db
			.prepare(`SELECT ${INPUT_COLUMNS} FROM life_inputs`)
			.iterate())
			decodeInput(raw as InputRow);
		for (const raw of this.db
			.prepare("SELECT agent_id FROM world_bindings")
			.iterate()) {
			const agentId = raw["agent_id"];
			id(agentId);
			this.binding(agentId);
		}
	}
}
