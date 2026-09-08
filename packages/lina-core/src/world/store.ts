import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../session-binding.ts";
import { AuthoringPersistence } from "./authoring-persistence.ts";
import { AuthoringRequests } from "./authoring-requests.ts";
import type { WorldAuthoringPort } from "./authoring-types.ts";
import { AutonomyPersistence } from "./autonomy-persistence.ts";
import type { WorldAutonomyPort } from "./autonomy-store-types.ts";
import { projectContext, validateContextLimits } from "./context.ts";
import { LifePersistence } from "./life-persistence.ts";
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
	parseBindingSelection,
	parseIdentityPolicy,
	parseLifeCommit,
	parseLifeDefinition,
	parseLifeInput,
} from "./life-validation.ts";
import { initializeWorldSchema } from "./schema.ts";
import { SocialPersistence } from "./social-persistence.ts";
import type { WorldSocialPort } from "./social-store-types.ts";
import { eventId, initialSnapshot, transition } from "./transition.ts";
import type {
	WorldContext,
	WorldContextLimits,
	WorldDefinition,
	WorldEvent,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import {
	id,
	integer,
	parseDefinition,
	parseProposal,
	text,
} from "./validation.ts";

type WorldRow = { id: string; definition_json: string; state_json: string };
type EventRow = {
	world_id: string;
	idempotency_key: string;
	revision: number;
	event_json: string;
};
const WORLD_COLUMNS = "id, definition_json, state_json";
const EVENT_COLUMNS = "world_id, idempotency_key, revision, event_json";

function eventProposal(event: WorldEvent): WorldProposal {
	const {
		id: _id,
		revision: _revision,
		acceptedAt: _acceptedAt,
		origin: _origin,
		definitionVersion: _version,
		...proposal
	} = event;
	return parseProposal(proposal);
}
function readEvent(row: EventRow): WorldEvent {
	const value = JSON.parse(row.event_json) as WorldEvent;
	const proposal = eventProposal(value);
	integer(value.revision, "event revision", 1);
	integer(value.definitionVersion, "definition version", 1);
	text(value.acceptedAt, "acceptance time");
	if (
		!Number.isFinite(Date.parse(value.acceptedAt)) ||
		value.origin !== "fictional" ||
		value.id !== eventId(row.world_id, row.revision) ||
		value.revision !== row.revision ||
		proposal.worldId !== row.world_id ||
		proposal.idempotencyKey !== row.idempotency_key
	)
		throw Error("Corrupt world event provenance");
	return {
		...proposal,
		id: value.id,
		revision: value.revision,
		acceptedAt: value.acceptedAt,
		origin: value.origin,
		definitionVersion: value.definitionVersion,
	};
}
function stateJson(snapshot: WorldSnapshot): string {
	const { definition: _definition, ...state } = snapshot;
	return JSON.stringify(state);
}

/** Trusted application API. Bind agent views in the runtime; never expose this store as an agent tool. */
export class WorldStore
	implements WorldAuthoringPort, WorldSocialPort, WorldAutonomyPort
{
	private readonly db: DatabaseSync;
	private readonly autonomy: AutonomyPersistence;
	private readonly life: LifePersistence;
	private readonly social: SocialPersistence;
	private readonly author: AuthoringPersistence;
	private readonly suggestions: AuthoringRequests;
	private closed = false;
	readonly acquireLifeLease: WorldAutonomyPort["acquireLifeLease"] = (
		worldId,
		expectedRevision,
		owner,
		_nowMs,
		leaseMs,
	) =>
		this.transaction(() =>
			this.autonomy.acquireLease(worldId, expectedRevision, owner, leaseMs),
		);
	readonly lifeStatus: WorldAutonomyPort["lifeStatus"] = (worldId) =>
		this.transaction(() => this.autonomy.status(worldId), false);
	readonly invalidateLifeIdentity: WorldAutonomyPort["invalidateLifeIdentity"] =
		(worldId, current) =>
			this.transaction(() =>
				this.autonomy.invalidateIdentity(worldId, current),
			);
	readonly prepareLifeStep: WorldAutonomyPort["prepareLifeStep"] = (
		request,
		entropy,
	) => this.transaction(() => this.autonomy.prepare(request, entropy));
	readonly lifeStep: WorldAutonomyPort["lifeStep"] = (worldId, stepId) =>
		this.transaction(() => this.autonomy.get(worldId, stepId), false);
	readonly renewLifeLease: WorldAutonomyPort["renewLifeLease"] = (
		lease,
		_nowMs,
		leaseMs,
	) => this.transaction(() => this.autonomy.schedules.renew(lease, leaseMs));
	readonly releaseLifeLease: WorldAutonomyPort["releaseLifeLease"] = (lease) =>
		this.transaction(() => this.autonomy.schedules.release(lease));
	readonly prepareLifeModel: WorldAutonomyPort["prepareLifeModel"] = (
		lease,
		stepId,
		request,
	) =>
		this.transaction(() => this.autonomy.prepareModel(lease, stepId, request));
	readonly dispatchLifeModel: WorldAutonomyPort["dispatchLifeModel"] = (
		lease,
		stepId,
		requestId,
	) =>
		this.transaction(() =>
			this.autonomy.dispatchModel(lease, stepId, requestId),
		);
	readonly finishLifeModel: WorldAutonomyPort["finishLifeModel"] = (
		worldId,
		stepId,
		requestId,
		result,
	) =>
		this.transaction(() =>
			this.autonomy.finishModel(worldId, stepId, requestId, result),
		);
	readonly recordLifeIntention: WorldAutonomyPort["recordLifeIntention"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.intention(lease, stepId));
	readonly recordLifeTarget: WorldAutonomyPort["recordLifeTarget"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.target(lease, stepId));
	readonly prepareLifeObservations: WorldAutonomyPort["prepareLifeObservations"] =
		(lease, stepId, requestId) =>
			this.transaction(() =>
				this.autonomy.observations(lease, stepId, requestId),
			);
	readonly finishLifeStep: WorldAutonomyPort["finishLifeStep"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.finish(lease, stepId));
	readonly acceptLifeStep: WorldAutonomyPort["acceptLifeStep"] = (
		lease,
		stepId,
		current,
	) => this.transaction(() => this.autonomy.accept(lease, stepId, current));
	readonly failLifeStep: WorldAutonomyPort["failLifeStep"] = (
		lease,
		stepId,
		reason,
	) => this.transaction(() => this.autonomy.fail(lease, stepId, reason));
	readonly advanceLifeSchedule: WorldAutonomyPort["advanceLifeSchedule"] = (
		lease,
		_nowMs,
		nextDue,
		skipped,
	) =>
		this.transaction(() =>
			this.autonomy.schedules.advance(lease, nextDue, skipped),
		);
	readonly prepareSocialResolution: WorldSocialPort["prepareSocialResolution"] =
		(...args) => this.transaction(() => this.social.prepare(...args));
	readonly socialResolution: WorldSocialPort["socialResolution"] = (...args) =>
		this.transaction(() => this.social.get(...args), false);
	readonly finishSocialResolution: WorldSocialPort["finishSocialResolution"] = (
		...args
	) => this.transaction(() => this.social.finish(...args));
	readonly acceptSocialResolution: WorldSocialPort["acceptSocialResolution"] = (
		worldId,
		requestId,
		identity,
	) =>
		this.transaction(() => {
			const parsed = parseIdentityPolicy(identity);
			return this.life.accept(
				this.social.commit(worldId, requestId, parsed),
				parsed,
			);
		});
	readonly draftWorld: WorldAuthoringPort["draftWorld"] = (...args) =>
		this.transaction(() => this.author.draftWorld(...args), true);
	readonly worldDraft: WorldAuthoringPort["worldDraft"] = (...args) =>
		this.transaction(() => this.author.worldDraft(...args), false);
	readonly worldDrafts: WorldAuthoringPort["worldDrafts"] = (...args) =>
		this.transaction(() => this.author.worldDrafts(...args), false);
	readonly worldCatalog: WorldAuthoringPort["worldCatalog"] = (...args) =>
		this.transaction(() => this.author.worldCatalog(...args), false);
	readonly editWorldDraft: WorldAuthoringPort["editWorldDraft"] = (...args) =>
		this.transaction(() => this.author.editWorldDraft(...args), true);
	readonly previewWorldDraft: WorldAuthoringPort["previewWorldDraft"] = (
		...args
	) => this.transaction(() => this.author.previewWorldDraft(...args), false);
	readonly activateWorldDraft: WorldAuthoringPort["activateWorldDraft"] = (
		...args
	) => this.transaction(() => this.author.activateWorldDraft(...args), true);
	readonly worldPack: WorldAuthoringPort["worldPack"] = (...args) =>
		this.transaction(() => this.author.worldPack(...args), false);
	readonly lifeConfig: WorldAuthoringPort["lifeConfig"] = (...args) =>
		this.transaction(() => this.author.lifeConfig(...args), false);
	readonly setLifeConfig: WorldAuthoringPort["setLifeConfig"] = (...args) =>
		this.transaction(() => {
			const config = this.author.setLifeConfig(...args);
			this.autonomy.configure(config.worldId, config.revision);
			return config;
		}, true);
	readonly grantWorldAuthor: WorldAuthoringPort["grantWorldAuthor"] = (
		...args
	) => this.transaction(() => this.author.grantWorldAuthor(...args), true);
	readonly worldAuthorGrant: WorldAuthoringPort["worldAuthorGrant"] = (
		...args
	) => this.transaction(() => this.author.worldAuthorGrant(...args), false);
	readonly revokeWorldAuthor: WorldAuthoringPort["revokeWorldAuthor"] = (
		...args
	) => this.transaction(() => this.author.revokeWorldAuthor(...args), true);
	readonly prepareWorldSuggestion: WorldAuthoringPort["prepareWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.prepare(...args), true);
	readonly worldSuggestion: WorldAuthoringPort["worldSuggestion"] = (...args) =>
		this.transaction(() => this.suggestions.get(...args), false);
	readonly dispatchWorldSuggestion: WorldAuthoringPort["dispatchWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.dispatch(...args), true);
	readonly finishWorldSuggestion: WorldAuthoringPort["finishWorldSuggestion"] =
		(...args) => this.transaction(() => this.suggestions.finish(...args), true);
	readonly failWorldSuggestion: WorldAuthoringPort["failWorldSuggestion"] = (
		...args
	) => this.transaction(() => this.suggestions.fail(...args), true);
	readonly abandonWorldSuggestion: WorldAuthoringPort["abandonWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.abandon(...args), true);
	constructor(
		path: string,
		private readonly now: () => number = Date.now,
	) {
		if (typeof path !== "string" || !path.trim())
			throw Error("Explicit world database path required");
		this.db =
			path === ":memory:"
				? new DatabaseSync(path)
				: openCheckedDatabase(path).db;
		this.social = new SocialPersistence(this.db, {
			autonomy: (request, source, historical) =>
				this.autonomy.socialAuthority(request, source, historical),
			source: (worldId) => ({
				world: this.snapshot(worldId),
				life: this.life.snapshot(worldId),
			}),
			sourceAt: (worldId, lifeRevision) => {
				const life = this.life.snapshotAt(worldId, lifeRevision);
				return {
					life,
					world: this.rebuild(
						this.snapshot(worldId).definition,
						life.worldRevision,
					),
				};
			},
			pack: (worldId, version) => this.author.worldPack(worldId, version),
		});
		this.life = new LifePersistence(this.db, {
			autonomyState: (worldId) => this.autonomy.state(worldId),
			autonomyStateAt: (worldId, revision) =>
				this.autonomy.stateAt(worldId, revision),
			saveAutonomyState: (state) => this.autonomy.changeDefinition(state),
			pack: (worldId, version) => this.author.worldPack(worldId, version),
			assertSocialCommit: (commit, identity, source, historical) => {
				this.autonomy.assertCommit(commit, identity, source, historical);
				this.social.assertCommit(commit, identity, source, historical);
			},
			markSocialAccepted: (commit) => this.social.markAccepted(commit),
			assertActors: (proposal) => this.author.assertActors(proposal),
			snapshot: (worldId) => this.snapshot(worldId),
			snapshotAt: (worldId, revision) =>
				this.rebuild(this.snapshot(worldId).definition, revision),
			proposalAt: (worldId, revision) => {
				const row = this.db
					.prepare(
						`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND revision = ?`,
					)
					.get(worldId, revision) as EventRow | undefined;
				if (!row) throw Error("Missing paired world event");
				return eventProposal(readEvent(row));
			},
			write: (proposal, next) => this.writeWorld(proposal, next),
		});
		this.author = new AuthoringPersistence(this.db, {
			exists: (worldId) => !!this.row(worldId),
			snapshot: (worldId) => this.snapshot(worldId),
			snapshotAt: (worldId, revision) =>
				this.rebuild(this.snapshot(worldId).definition, revision),
			create: (definition) => this.createWorld(definition),
			life: this.life,
		});
		this.autonomy = new AutonomyPersistence(
			this.db,
			{
				source: (worldId) => ({
					world: this.snapshot(worldId),
					life: this.life.snapshot(worldId),
				}),
				sourceAt: (worldId, revision) => {
					const life = this.life.snapshotAt(worldId, revision);
					return {
						life,
						world: this.rebuild(
							this.snapshot(worldId).definition,
							life.worldRevision,
						),
					};
				},
				worldAt: (worldId, revision) =>
					this.rebuild(this.snapshot(worldId).definition, revision),
				pack: (worldId, version) => this.author.worldPack(worldId, version),
				config: (worldId) => this.author.lifeConfig(worldId),
				configAt: (worldId, revision) =>
					this.author.lifeConfigAt(worldId, revision),
				inputs: (worldId) => this.life.inputs(worldId),
				accept: (commit, identity) => this.life.accept(commit, identity),
				social: (worldId, requestId, source) =>
					this.social.getAt(worldId, requestId, source),
			},
			this.now,
		);
		this.suggestions = new AuthoringRequests(this.db, this.author);
		let transactionStarted = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
			this.db.exec("BEGIN IMMEDIATE");
			transactionStarted = true;
			initializeWorldSchema(
				this.db,
				() => this.auditWorld(),
				() => this.audit(false, false, false),
				() => this.audit(true, false, false),
				() => this.audit(true, true, false),
			);
			this.audit();
			this.suggestions.recover();
			this.db.exec("COMMIT");
			transactionStarted = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (transactionStarted) this.rollback();
			this.db.close();
			throw error;
		}
	}
	create(input: WorldDefinition): WorldSnapshot {
		const definition = parseDefinition(input);
		return this.transaction(() => this.createWorld(definition));
	}
	private createWorld(definition: WorldDefinition): WorldSnapshot {
		const existing = this.row(definition.id);
		if (existing) {
			if (!isDeepStrictEqual(JSON.parse(existing.definition_json), definition))
				throw Error("World definition conflict; definitions are immutable");
			return this.decode(existing);
		}
		const snapshot = initialSnapshot(definition);
		this.db
			.prepare(
				"INSERT INTO worlds (id, definition_json, state_json) VALUES (?, ?, ?)",
			)
			.run(definition.id, JSON.stringify(definition), stateJson(snapshot));
		this.db
			.prepare(
				"INSERT INTO world_definition_versions (world_id, version, definition_json) VALUES (?, ?, ?)",
			)
			.run(definition.id, definition.version, JSON.stringify(definition));
		return snapshot;
	}
	snapshot(worldId: string): WorldSnapshot {
		this.assertOpen();
		id(worldId);
		const row = this.row(worldId);
		if (!row) throw Error("Unknown world");
		return this.decode(row);
	}
	/** Trusted historical view for freezing an image/job brief after an accepted event. */
	snapshotAt(worldId: string, revision: number): WorldSnapshot {
		integer(revision, "historical revision");
		return this.transaction(() => {
			const current = this.snapshot(worldId);
			if (revision > current.revision) throw Error("Unknown world revision");
			return this.rebuild(current.definition, revision);
		}, false);
	}
	preview(input: WorldProposal): WorldSnapshot {
		const proposal = parseProposal(input);
		return transition(this.snapshot(proposal.worldId), proposal);
	}
	accept(input: WorldProposal): { event: WorldEvent; replayed: boolean } {
		const proposal = parseProposal(input);
		if (proposal.kind === "definition")
			throw Error("WORLD_CONFIRMATION_REQUIRED");
		return this.transaction(() => {
			const previous = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND idempotency_key = ?`,
				)
				.get(proposal.worldId, proposal.idempotencyKey) as EventRow | undefined;
			if (previous) {
				const event = readEvent(previous);
				this.life.legacyWrite(proposal.worldId, event.revision);
				if (!isDeepStrictEqual(eventProposal(event), proposal))
					throw Error("World idempotency key conflicts with accepted payload");
				return { event, replayed: true };
			}
			this.life.legacyWrite(proposal.worldId);
			this.author.assertActors(proposal);
			const next = transition(this.snapshot(proposal.worldId), proposal);
			const event = this.writeWorld(proposal, next);
			return { event, replayed: false };
		});
	}
	private writeWorld(proposal: WorldProposal, next: WorldSnapshot): WorldEvent {
		const event: WorldEvent = {
			...proposal,
			id: eventId(proposal.worldId, next.revision),
			revision: next.revision,
			acceptedAt: new Date(this.now()).toISOString(),
			origin: "fictional",
			definitionVersion: next.definition.version,
		};
		this.db
			.prepare(
				"INSERT INTO world_events (world_id, idempotency_key, revision, event_json) VALUES (?, ?, ?, ?)",
			)
			.run(
				proposal.worldId,
				proposal.idempotencyKey,
				event.revision,
				JSON.stringify(event),
			);
		if (proposal.kind === "definition") {
			this.db
				.prepare(
					"INSERT INTO world_definition_versions (world_id, version, definition_json) VALUES (?, ?, ?)",
				)
				.run(
					proposal.worldId,
					next.definition.version,
					JSON.stringify(next.definition),
				);
			this.db
				.prepare(
					"UPDATE worlds SET definition_json = ?, state_json = ? WHERE id = ?",
				)
				.run(
					JSON.stringify(next.definition),
					stateJson(next),
					proposal.worldId,
				);
		} else
			this.db
				.prepare("UPDATE worlds SET state_json = ? WHERE id = ?")
				.run(stateJson(next), proposal.worldId);
		return event;
	}
	prepareLife(input: LifeDefinition): LifeState {
		const definition = parseLifeDefinition(input);
		return this.transaction(() => this.life.prepare(definition));
	}
	isLifePrepared(worldId: string): boolean {
		id(worldId);
		return this.transaction(() => {
			this.snapshot(worldId);
			return this.life.prepared(worldId);
		}, false);
	}
	lifeDefinition(worldId: string): LifeDefinition {
		id(worldId);
		return this.transaction(() => this.life.definition(worldId), false);
	}
	lifeSnapshot(worldId: string): LifeState {
		id(worldId);
		return this.transaction(() => this.life.snapshot(worldId), false);
	}
	lifeSnapshotAt(worldId: string, revision: number): LifeState {
		id(worldId);
		integer(revision, "historical LIFE revision");
		return this.transaction(
			() => this.life.snapshotAt(worldId, revision),
			false,
		);
	}
	previewLife(input: LifeCommit, policy: IdentityPolicySnapshot): LifePreview {
		const commit = parseLifeCommit(input),
			identity = parseIdentityPolicy(policy);
		return this.transaction(() => this.life.preview(commit, identity), false);
	}
	acceptLife(input: LifeCommit, policy: IdentityPolicySnapshot): LifeReceipt {
		const commit = parseLifeCommit(input),
			identity = parseIdentityPolicy(policy);
		if (commit.version === 3)
			throw Error("Autonomous step acceptance required");
		return this.transaction(() => this.life.accept(commit, identity));
	}
	admitLifeInput(input: LifeInput): AdmissionReceipt {
		const parsed = parseLifeInput(input);
		return this.transaction(() => this.life.admit(parsed));
	}
	lifeInputs(worldId: string): LifeInput[] {
		id(worldId);
		return this.transaction(() => this.life.inputs(worldId), false);
	}
	lifeEffects(worldId: string): SideEffectIntent[] {
		id(worldId);
		return this.transaction(() => this.life.effects(worldId), false);
	}
	worldBinding(agentId: string): WorldBinding | null {
		id(agentId);
		return this.transaction(() => this.life.binding(agentId), false);
	}
	setWorldBinding(
		agentId: string,
		expectedRevision: number,
		input: BindingSelection,
	): WorldBinding {
		id(agentId);
		integer(expectedRevision, "binding revision");
		const selection = parseBindingSelection(input);
		return this.transaction(() =>
			this.life.bind(agentId, expectedRevision, selection),
		);
	}
	context(
		worldId: string,
		agentId: string,
		limits: WorldContextLimits,
	): WorldContext {
		validateContextLimits(limits);
		return this.transaction(() => {
			const snapshot = this.snapshot(worldId);
			if (!snapshot.definition.agents.includes(agentId))
				throw Error("Unknown world agent");
			const rows = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND EXISTS (SELECT 1 FROM json_each(event_json, '$.audience') WHERE value = ?) ORDER BY revision DESC LIMIT ?`,
				)
				.all(worldId, agentId, limits.maxEvents + 1) as EventRow[];
			return projectContext(snapshot, agentId, rows.map(readEvent), limits);
		}, false);
	}
	/** Re-open audits atomic state against accepted events, without replaying any external effect. */
	private audit(
		includeAuthor = true,
		includeSocial = true,
		includeAutonomy = true,
	): void {
		this.auditWorld();
		const definitions = this.db
			.prepare(
				"SELECT world_id, version, definition_json FROM world_definition_versions",
			)
			.all() as Array<{
			world_id: string;
			version: number;
			definition_json: string;
		}>;
		const worlds = this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds`)
			.all() as WorldRow[];
		const referenced = new Set<string>();
		for (const world of worlds) {
			const entries = definitions
				.filter((row) => row.world_id === world.id)
				.sort((a, b) => a.version - b.version);
			if (!entries.length) throw Error("Missing initial world definition");
			referenced.add(`${world.id}:${entries[0]?.version}`);
			for (const raw of this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? ORDER BY revision`,
				)
				.iterate(world.id)) {
				const event = readEvent(raw as EventRow);
				if (event.kind === "definition")
					referenced.add(`${world.id}:${event.definition.version}`);
			}
		}
		for (const row of definitions) {
			const definition = parseDefinition(JSON.parse(row.definition_json));
			integer(row.version, "definition registry version", 1);
			const world = worlds.find((item) => item.id === row.world_id);
			if (
				!world ||
				definition.id !== row.world_id ||
				definition.version !== row.version ||
				!referenced.has(`${row.world_id}:${row.version}`)
			)
				throw Error("Corrupt world definition registry");
		}
		this.life.audit();
		if (includeSocial) this.social.audit();
		if (includeAutonomy) this.autonomy.audit();
		if (includeAuthor) {
			this.author.audit();
			this.suggestions.audit();
		}
	}
	private auditWorld(): void {
		const worlds = this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds ORDER BY id`)
			.all() as WorldRow[];
		if (this.db.prepare("PRAGMA foreign_key_check").all().length)
			throw Error("Corrupt world event references");
		for (const row of worlds) {
			const saved = this.decode(row);
			const rebuilt = this.rebuild(saved.definition);
			if (!isDeepStrictEqual(saved, rebuilt))
				throw Error("Corrupt world checkpoint");
		}
	}
	private rebuild(
		definition: WorldDefinition,
		revision?: number,
	): WorldSnapshot {
		const hasRegistry = !!this.db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'world_definition_versions'",
			)
			.get();
		const original = hasRegistry
			? (this.db
					.prepare(
						"SELECT definition_json FROM world_definition_versions WHERE world_id = ? ORDER BY version LIMIT 1",
					)
					.get(definition.id) as { definition_json: string } | undefined)
			: undefined;
		if (hasRegistry && !original)
			throw Error("Missing original world definition");
		let rebuilt = initialSnapshot(
			original
				? parseDefinition(JSON.parse(original.definition_json))
				: definition,
		);
		// Startup must inspect every stored row, including unsupported revisions.
		// Only an explicit historical lookup is allowed to bound the scan.
		const query = this.db.prepare(
			`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ?${revision === undefined ? "" : " AND revision <= ?"} ORDER BY revision`,
		);
		const rows =
			revision === undefined
				? query.iterate(definition.id)
				: query.iterate(definition.id, revision);
		for (const row of rows) {
			const event = readEvent(row as EventRow);
			rebuilt = transition(rebuilt, eventProposal(event));
			if (event.definitionVersion !== rebuilt.definition.version)
				throw Error("Corrupt world definition version");
			if (event.kind === "definition") {
				const entry = this.db
					.prepare(
						"SELECT definition_json FROM world_definition_versions WHERE world_id = ? AND version = ?",
					)
					.get(definition.id, event.definitionVersion) as
					| { definition_json: string }
					| undefined;
				if (
					!entry ||
					!isDeepStrictEqual(
						parseDefinition(JSON.parse(entry.definition_json)),
						event.definition,
					)
				)
					throw Error("Corrupt world definition registry");
			}
			if (event.revision !== rebuilt.revision)
				throw Error("Corrupt world event revision");
		}
		if (revision !== undefined && rebuilt.revision !== revision)
			throw Error("Missing world event revision");
		return rebuilt;
	}
	private decode(row: WorldRow): WorldSnapshot {
		const definition = parseDefinition(JSON.parse(row.definition_json));
		if (row.id !== definition.id) throw Error("Corrupt world identity");
		return { ...JSON.parse(row.state_json), definition } as WorldSnapshot;
	}
	private row(worldId: string): WorldRow | undefined {
		return this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds WHERE id = ?`)
			.get(worldId) as WorldRow | undefined;
	}
	private transaction<T>(action: () => T, write = true): T {
		this.assertOpen();
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}
	private rollback(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			/* SQLite may have aborted already; preserve the original failure. */
		}
	}
	private assertOpen(): void {
		if (this.closed) throw Error("World store is closed");
	}
	close(): void {
		if (this.closed) return;
		this.transaction(() => this.suggestions.close());
		this.db.close();
		this.closed = true;
	}
}
