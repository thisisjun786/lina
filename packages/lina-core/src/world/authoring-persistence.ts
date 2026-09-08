import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { evaluateWorld, worldReadiness } from "./authoring.ts";
import { parseWorldDraftPreview } from "./authoring-receipt.ts";
import { parseAuthoringQuestions } from "./authoring-suggestion.ts";
import type {
	LifeConfig,
	LifeConfigInput,
	WorldActivationReceipt,
	WorldAuthorGrant,
	WorldAuthorScope,
	WorldConfirmation,
	WorldDraft,
	WorldDraftCursor,
	WorldDraftInput,
	WorldDraftPatch,
	WorldDraftPreview,
	WorldPack,
	WorldPreviewOptions,
	WorldSuggestionContent,
} from "./authoring-types.ts";
import {
	parseLifeConfigInput,
	parseWorldConfirmation,
	parseWorldDraftCursor,
	parseWorldDraftInput,
	parseWorldDraftPatch,
	parseWorldPack,
	parseWorldPreviewOptions,
} from "./authoring-validation.ts";
import type {
	AutonomyMigrationPreview,
	AutonomyState,
} from "./autonomy-types.ts";
import { projectContext } from "./context.ts";
import { migrateLifeDefinitionResult } from "./life-definition.ts";
import { canonicalLifeJson, lifeDigest } from "./life-json.ts";
import type { LifePersistence } from "./life-persistence.ts";
import type { SocialMigrationPreview } from "./social-types.ts";
import { initialSnapshot, transition } from "./transition.ts";
import type {
	WorldDefinition,
	WorldDefinitionProposal,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import { fields, id, integer, text } from "./validation.ts";
import { assertWorkConfigReferences } from "./work-validation.ts";

export type AuthorWorldAccess = {
	exists(worldId: string): boolean;
	snapshot(worldId: string): WorldSnapshot;
	snapshotAt(worldId: string, revision: number): WorldSnapshot;
	create(definition: WorldDefinition): WorldSnapshot;
	life: LifePersistence;
};
type DraftRow = {
	draft_id: string;
	revision: number;
	draft_json: string;
	digest: string;
};
type PackRow = {
	world_id: string;
	version: number;
	effective_revision: number;
	pack_json: string;
	digest: string;
};
type ActivationRow = {
	world_id: string;
	idempotency_key: string;
	input_digest: string;
	draft_id: string;
	draft_revision: number;
	confirmation_json: string;
	receipt_json: string;
};
const INCOMPLETE = worldReadiness(null);
const EMPTY_CONFIG: LifeConfigInput = {
	version: 1,
	clock: null,
	run: null,
	models: null,
	limits: null,
	usage: null,
	publication: null,
	images: null,
	avatars: null,
};

function draftDigest(value: Omit<WorldDraft, "digest">): WorldDraft {
	return { ...value, digest: lifeDigest(value) };
}
function activationEventKey(worldId: string, idempotencyKey: string): string {
	return `definition-${lifeDigest({ worldId, idempotencyKey })}`;
}
function readDraft(row: DraftRow): WorldDraft {
	const raw: unknown = JSON.parse(row.draft_json);
	fields(raw, [
		"version",
		"id",
		"worldId",
		"revision",
		"baseWorldVersion",
		"baseWorldRevision",
		"authoredText",
		"pack",
		"suggestion",
		"unresolved",
		"digest",
	]);
	if (raw.version !== 1) throw Error("Unsupported world draft version");
	id(raw.id);
	id(raw.worldId);
	integer(raw.revision, "draft revision", 1);
	text(raw.authoredText, "authored text");
	for (const value of [raw.baseWorldVersion, raw.baseWorldRevision])
		if (value !== null) integer(value, "draft base revision");
	if (raw.baseWorldVersion !== null)
		integer(raw.baseWorldVersion, "draft base version", 1);
	if ((raw.baseWorldVersion === null) !== (raw.baseWorldRevision === null))
		throw Error("Corrupt draft base");
	const pack = raw.pack === null ? null : parseWorldPack(raw.pack);
	if (pack && pack.worldId !== raw.worldId) throw Error("Draft world mismatch");
	if (raw.suggestion !== null) {
		fields(raw.suggestion, ["requestId", "provider", "model", "inputDigest"]);
		id(raw.suggestion.requestId);
		text(raw.suggestion.provider, "suggestion provider");
		text(raw.suggestion.model, "suggestion model");
		if (
			typeof raw.suggestion.inputDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(raw.suggestion.inputDigest)
		)
			throw Error("Invalid suggestion provenance");
	}
	if (
		!isDeepStrictEqual(
			raw.unresolved,
			pack === null && raw.suggestion !== null
				? parseAuthoringQuestions(raw.unresolved)
				: worldReadiness(pack),
		)
	)
		throw Error("Corrupt draft questions");
	const { digest: savedDigest, ...content } = raw;
	if (
		raw.id !== row.draft_id ||
		raw.revision !== row.revision ||
		savedDigest !== row.digest ||
		lifeDigest(content) !== row.digest
	)
		throw Error("Corrupt world draft digest");
	return { ...raw, pack } as unknown as WorldDraft;
}

/** Internal author SQL owner; WorldStore supplies the single transaction and management/grant boundary. */
export class AuthoringPersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly world: AuthorWorldAccess,
	) {}
	authorize(
		worldId: string,
		scope: WorldAuthorScope = { kind: "management" },
	): WorldAuthorScope {
		id(worldId);
		if ("kind" in scope) {
			fields(scope, ["kind"]);
			if (scope.kind !== "management") throw Error("Invalid author scope");
			return scope;
		}
		fields(scope, ["grantId", "grantRevision"]);
		id(scope.grantId);
		integer(scope.grantRevision, "grant revision", 1);
		const grant = this.worldAuthorGrant(scope.grantId);
		if (
			grant.status !== "active" ||
			grant.revision !== scope.grantRevision ||
			grant.worldId !== worldId
		)
			throw Error("World author grant is revoked or outside scope");
		return scope;
	}
	private scopedWorld(scope?: WorldAuthorScope): string | null {
		if (!scope || "kind" in scope) {
			if (scope) this.authorize("scope-check", scope);
			return null;
		}
		const grant = this.worldAuthorGrant(scope.grantId);
		this.authorize(grant.worldId, scope);
		return grant.worldId;
	}
	draftWorld(input: WorldDraftInput, scope?: WorldAuthorScope): WorldDraft {
		const parsed = parseWorldDraftInput(input);
		this.authorize(parsed.worldId, scope);
		const current = this.world.exists(parsed.worldId)
			? this.world.snapshot(parsed.worldId)
			: null;
		const draft = draftDigest({
			version: 1,
			id: randomUUID(),
			worldId: parsed.worldId,
			revision: 1,
			baseWorldVersion: current?.definition.version ?? null,
			baseWorldRevision: current?.revision ?? null,
			authoredText: parsed.authoredText,
			pack: null,
			suggestion: null,
			unresolved: structuredClone(INCOMPLETE),
		});
		this.db
			.prepare(
				"INSERT INTO world_drafts (id, world_id, revision) VALUES (?, ?, ?)",
			)
			.run(draft.id, draft.worldId, 1);
		this.appendDraft(draft);
		return draft;
	}
	draftAt(draftId: string, revision: number): WorldDraft {
		id(draftId);
		integer(revision, "draft revision", 1);
		const row = this.db
			.prepare(
				"SELECT draft_id, revision, draft_json, digest FROM world_draft_versions WHERE draft_id = ? AND revision = ?",
			)
			.get(draftId, revision) as DraftRow | undefined;
		if (!row) throw Error("Unknown world draft revision");
		return readDraft(row);
	}
	worldDraft(draftId: string, scope?: WorldAuthorScope): WorldDraft {
		id(draftId);
		const head = this.db
			.prepare("SELECT world_id, revision FROM world_drafts WHERE id = ?")
			.get(draftId) as { world_id: string; revision: number } | undefined;
		if (!head) throw Error("Unknown world draft");
		this.authorize(head.world_id, scope);
		const draft = this.draftAt(draftId, head.revision);
		if (draft.worldId !== head.world_id) throw Error("Corrupt draft world");
		return draft;
	}
	worldDrafts(input: WorldDraftCursor, scope?: WorldAuthorScope) {
		const cursor = parseWorldDraftCursor(input),
			worldId = this.scopedWorld(scope);
		const rows = this.db
			.prepare(
				"SELECT id FROM world_drafts WHERE (? IS NULL OR world_id = ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
			)
			.all(
				worldId,
				worldId,
				cursor.afterId,
				cursor.afterId,
				cursor.limit + 1,
			) as Array<{ id: string }>;
		const items = rows
			.slice(0, cursor.limit)
			.map((row) => this.worldDraft(row.id, scope));
		return {
			items,
			nextCursor:
				rows.length > cursor.limit ? (items.at(-1)?.id ?? null) : null,
		};
	}
	worldCatalog(input: WorldDraftCursor, scope?: WorldAuthorScope) {
		const cursor = parseWorldDraftCursor(input),
			worldId = this.scopedWorld(scope);
		const rows = this.db
			.prepare(
				"SELECT id FROM worlds WHERE (? IS NULL OR id = ?) AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?",
			)
			.all(
				worldId,
				worldId,
				cursor.afterId,
				cursor.afterId,
				cursor.limit + 1,
			) as Array<{ id: string }>;
		const items = rows.slice(0, cursor.limit).map(({ id }) => {
			const state = this.world.snapshot(id);
			return {
				worldId: id,
				title: state.definition.title,
				version: state.definition.version,
				worldRevision: state.revision,
				packVersion: this.currentPack(id)?.version ?? null,
			};
		});
		return {
			items,
			nextCursor:
				rows.length > cursor.limit ? (items.at(-1)?.worldId ?? null) : null,
		};
	}
	private appendDraft(draft: WorldDraft): void {
		this.db
			.prepare(
				"INSERT INTO world_draft_versions (draft_id, revision, draft_json, digest) VALUES (?, ?, ?, ?)",
			)
			.run(draft.id, draft.revision, canonicalLifeJson(draft), draft.digest);
		this.db
			.prepare("UPDATE world_drafts SET revision = ? WHERE id = ?")
			.run(draft.revision, draft.id);
	}
	editWorldDraft(
		draftId: string,
		expectedRevision: number,
		input: WorldDraftPatch,
		scope?: WorldAuthorScope,
	): WorldDraft {
		const patch = parseWorldDraftPatch(input),
			previous = this.worldDraft(draftId, scope);
		integer(expectedRevision, "draft revision", 1);
		if (previous.revision !== expectedRevision)
			throw Error("World draft revision conflict");
		if (patch.pack && patch.pack.worldId !== previous.worldId)
			throw Error("World draft pack mismatch");
		const { digest: _digest, ...content } = previous;
		const draft = draftDigest({
			...content,
			...patch,
			revision: expectedRevision + 1,
			suggestion: null,
			unresolved: worldReadiness(patch.pack),
		});
		this.appendDraft(draft);
		return draft;
	}
	applySuggestion(
		draftId: string,
		expectedRevision: number,
		result: WorldSuggestionContent,
		suggestion: NonNullable<WorldDraft["suggestion"]>,
		scope: WorldAuthorScope,
	): WorldDraft {
		const previous = this.worldDraft(draftId, scope);
		if (previous.revision !== expectedRevision)
			throw Error("World draft revision conflict");
		const pack = result.pack;
		if (pack && pack.worldId !== previous.worldId)
			throw Error("World draft pack mismatch");
		const { digest: _digest, ...content } = previous;
		const draft = draftDigest({
			...content,
			revision: expectedRevision + 1,
			pack,
			suggestion,
			unresolved:
				result.pack === null
					? parseAuthoringQuestions(result.unresolved)
					: worldReadiness(pack),
		});
		this.appendDraft(draft);
		return draft;
	}
	currentPack(worldId: string): WorldPack | null {
		const row = this.db
			.prepare(
				"SELECT world_id, version, effective_revision, pack_json, digest FROM world_packs WHERE world_id = ? ORDER BY version DESC LIMIT 1",
			)
			.get(worldId) as PackRow | undefined;
		return row ? this.decodePack(row) : null;
	}
	private decodePack(row: PackRow): WorldPack {
		integer(row.effective_revision, "pack effective revision");
		const pack = parseWorldPack(JSON.parse(row.pack_json));
		if (
			pack.worldId !== row.world_id ||
			pack.version !== row.version ||
			lifeDigest(pack) !== row.digest
		)
			throw Error("Corrupt world pack provenance");
		return pack;
	}
	worldPack(
		worldId: string,
		version?: number,
		scope?: WorldAuthorScope,
	): WorldPack {
		this.authorize(worldId, scope);
		if (version === undefined) {
			const pack = this.currentPack(worldId);
			if (!pack) throw Error("Unknown world pack");
			return pack;
		}
		integer(version, "pack version", 1);
		const row = this.db
			.prepare(
				"SELECT world_id, version, effective_revision, pack_json, digest FROM world_packs WHERE world_id = ? AND version = ?",
			)
			.get(worldId, version) as PackRow | undefined;
		if (!row) throw Error("Unknown world pack version");
		return this.decodePack(row);
	}
	private definitionProposal(
		pack: WorldPack,
		options: WorldPreviewOptions,
		key: string,
	): WorldDefinitionProposal {
		if (options.expectedWorldRevision === null)
			throw Error("World revision conflict");
		return {
			worldId: pack.worldId,
			idempotencyKey: key,
			expectedRevision: options.expectedWorldRevision,
			simulationTime: options.simulationTime,
			kind: "definition",
			sceneId: null,
			actorIds: [],
			audience: [],
			summary: "",
			facts: [],
			moves: [],
			definition: pack.world,
			relocations: options.relocations,
		};
	}
	previewWorldDraft(
		draftId: string,
		expectedRevision: number,
		input: WorldPreviewOptions,
		scope?: WorldAuthorScope,
	): WorldDraftPreview {
		const options = parseWorldPreviewOptions(input),
			draft = this.worldDraft(draftId, scope);
		integer(expectedRevision, "draft revision", 1);
		if (draft.revision !== expectedRevision)
			throw Error("World draft revision conflict");
		const current = this.world.exists(draft.worldId)
			? this.world.snapshot(draft.worldId)
			: null;
		if (
			(current?.revision ?? null) !== options.expectedWorldRevision ||
			(current?.definition.version ?? null) !== draft.baseWorldVersion
		)
			throw Error("World draft base revision conflict");
		const pack = draft.pack,
			previousPack = current ? this.currentPack(draft.worldId) : null;
		let selected: WorldSnapshot | null = null;
		let socialMigration: SocialMigrationPreview | null = null;
		let autonomyMigration: AutonomyMigrationPreview | null = null;
		let autonomyState: AutonomyState | null = null;
		if (pack) {
			if (!current) {
				if (
					options.simulationTime !== pack.world.initialTime ||
					options.relocations.length
				)
					throw Error("Initial world boundary mismatch");
				selected = initialSnapshot(pack.world);
			} else if (!previousPack) {
				if (
					!isDeepStrictEqual(pack.world, current.definition) ||
					options.simulationTime !== current.simulationTime ||
					options.relocations.length
				)
					throw Error(
						"Adopt the existing world baseline exactly before changing it",
					);
				if (
					this.world.life.prepared(draft.worldId) &&
					!isDeepStrictEqual(
						this.world.life.definition(draft.worldId),
						pack.life,
					)
				)
					throw Error("LIFE baseline conflict");
				selected = current;
			} else {
				const proposal = this.definitionProposal(
					pack,
					options,
					"preview-definition",
				);
				selected = transition(current, proposal);
				const migration = this.world.life.previewDefinitionResult(
					proposal,
					pack.life,
					pack,
				);
				socialMigration = migration.socialMigration;
				autonomyMigration = migration.autonomyMigration;
				autonomyState = migration.autonomyState;
			}
			for (const role of pack.roles.filter(
				(role) => role.status === "retired",
			)) {
				if (
					selected.scenes.some((scene) =>
						scene.occupants.includes(role.agentId),
					)
				)
					throw Error("Retirement requires an explicit leave placement");
				if (
					previousPack?.roles.some(
						(previous) =>
							previous.agentId === role.agentId &&
							previous.status === "retired",
					) === false &&
					!options.relocations.some(
						(move) => move.agentId === role.agentId && move.sceneId === null,
					)
				)
					throw Error("Retirement requires an explicit leave placement");
			}
			if (
				previousPack?.roles.some(
					(role) =>
						role.status === "retired" &&
						pack.roles.some(
							(next) =>
								next.agentId === role.agentId && next.status !== "retired",
						),
				)
			)
				throw Error(
					"Retired agent reactivation requires a membership migration",
				);
		}
		const changes = {
			addedAgents:
				pack?.world.agents.filter(
					(agent) => !current?.definition.agents.includes(agent),
				) ?? [],
			retiredAgents:
				pack?.roles
					.filter(
						(role) =>
							role.status === "retired" &&
							!previousPack?.roles.some(
								(old) =>
									old.agentId === role.agentId && old.status === "retired",
							),
					)
					.map((role) => role.agentId) ?? [],
			removedScenes:
				current?.definition.scenes
					.filter(
						(scene) => !pack?.world.scenes.some((next) => next.id === scene.id),
					)
					.map((scene) => scene.id) ?? [],
			changedPlaces:
				pack?.world.places
					.filter(
						(place) =>
							!isDeepStrictEqual(
								place,
								current?.definition.places.find((old) => old.id === place.id),
							),
					)
					.map((place) => place.id) ?? [],
			changedRuleIds: [
				...new Set(
					[...(pack?.rules ?? []), ...(previousPack?.rules ?? [])].map(
						(rule) => rule.id,
					),
				),
			].filter(
				(id) =>
					!isDeepStrictEqual(
						pack?.rules.find((rule) => rule.id === id),
						previousPack?.rules.find((rule) => rule.id === id),
					),
			),
		};
		const perception =
			selected && !draft.unresolved.some((question) => question.blocking)
				? projectContext(selected, options.agentId, [], {
						maxChars: options.limits.maxChars,
						maxFacts: options.limits.maxRecords,
						maxEvents: 0,
					})
				: null;
		const evaluation =
			pack && perception
				? evaluateWorld(pack, {
						worldId: pack.worldId,
						agentId: options.agentId,
						targetAgentId: options.targetAgentId,
						recipientId: null,
						evaluationId: draft.id,
						seed: options.seed,
						text: JSON.stringify(perception),
						variables:
							autonomyState?.variables ??
							Object.fromEntries(
								pack.variables.map((variable) => [
									variable.id,
									variable.initial,
								]),
							),
						limits: options.limits,
					})
				: null;
		const body = {
			version: 1 as const,
			draftId,
			draftRevision: expectedRevision,
			worldId: draft.worldId,
			packDigest: pack ? lifeDigest(pack) : null,
			options,
			unresolved: draft.unresolved,
			changes,
			evaluation,
			canActivate:
				!!pack && !draft.unresolved.some((question) => question.blocking),
		};
		const versioned =
			pack?.schemaVersion === 3
				? { ...body, version: 3 as const, socialMigration, autonomyMigration }
				: pack?.schemaVersion === 2
					? { ...body, version: 2 as const, socialMigration }
					: body;
		return parseWorldDraftPreview({
			...versioned,
			digest: lifeDigest(versioned),
		});
	}
	activateWorldDraft(
		input: WorldConfirmation,
		scope?: WorldAuthorScope,
	): WorldActivationReceipt {
		const confirmation = parseWorldConfirmation(input),
			currentDraft = this.worldDraft(confirmation.draftId, scope);
		const prior = this.db
			.prepare(
				"SELECT * FROM world_activations WHERE world_id = ? AND idempotency_key = ?",
			)
			.get(currentDraft.worldId, confirmation.idempotencyKey) as
			| ActivationRow
			| undefined;
		if (prior) {
			if (prior.input_digest !== lifeDigest(confirmation))
				throw Error("World confirmation idempotency conflict");
			return { ...this.readActivation(prior), replayed: true };
		}
		const preview = this.previewWorldDraft(
				confirmation.draftId,
				confirmation.expectedRevision,
				confirmation.options,
				scope,
			),
			pack = currentDraft.pack;
		if (pack && this.world.exists(pack.worldId)) {
			const config = this.lifeConfig(pack.worldId);
			if (config.version === 2 && config.work)
				assertWorkConfigReferences(config.work, pack);
		}
		if (
			!pack ||
			!preview.canActivate ||
			preview.digest !== confirmation.previewDigest ||
			preview.packDigest !== confirmation.packDigest
		)
			throw Error(
				"World confirmation preview conflict or unresolved structure",
			);
		let eventId: string | null = null;
		if (!this.world.exists(pack.worldId)) this.world.create(pack.world);
		const existingPack = this.currentPack(pack.worldId);
		if (!existingPack) this.world.life.prepare(pack.life);
		else {
			const proposal = this.definitionProposal(
				pack,
				confirmation.options,
				activationEventKey(pack.worldId, confirmation.idempotencyKey),
			);
			const state = this.world.life.changeDefinition(proposal, pack.life, pack);
			eventId = `${pack.worldId}:${state.worldRevision}`;
		}
		const world = this.world.snapshot(pack.worldId),
			life = this.world.life.snapshot(pack.worldId);
		this.db
			.prepare(
				"INSERT INTO world_packs (world_id, version, effective_revision, pack_json, digest) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				pack.worldId,
				pack.version,
				world.revision,
				canonicalLifeJson(pack),
				lifeDigest(pack),
			);
		const receiptBody = {
			worldId: pack.worldId,
			worldVersion: pack.version,
			worldRevision: world.revision,
			lifeRevision: life.revision,
			draftId: currentDraft.id,
			draftRevision: currentDraft.revision,
			eventId,
			inputDigest: lifeDigest(confirmation),
			preview,
			replayed: false,
		};
		const receipt: WorldActivationReceipt =
			preview.version === 3
				? { ...receiptBody, version: 3, preview }
				: preview.version === 2
					? { ...receiptBody, version: 2, preview }
					: { ...receiptBody, version: 1, preview };
		this.db
			.prepare(
				"INSERT INTO world_activations (world_id, idempotency_key, input_digest, draft_id, draft_revision, confirmation_json, receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				pack.worldId,
				confirmation.idempotencyKey,
				receipt.inputDigest,
				currentDraft.id,
				currentDraft.revision,
				canonicalLifeJson(confirmation),
				canonicalLifeJson(receipt),
			);
		return receipt;
	}
	private readActivation(row: ActivationRow): WorldActivationReceipt {
		const confirmation = parseWorldConfirmation(
			JSON.parse(row.confirmation_json),
		);
		const value: unknown = JSON.parse(row.receipt_json);
		fields(value, [
			"version",
			"worldId",
			"worldVersion",
			"worldRevision",
			"lifeRevision",
			"draftId",
			"draftRevision",
			"eventId",
			"inputDigest",
			"preview",
			"replayed",
		]);
		const receipt = value as unknown as WorldActivationReceipt;
		for (const number of [receipt.worldVersion, receipt.draftRevision])
			integer(number, "activation version", 1);
		for (const number of [receipt.worldRevision, receipt.lifeRevision])
			integer(number, "activation revision");
		const draft = this.draftAt(row.draft_id, row.draft_revision),
			pack = this.worldPack(row.world_id, receipt.worldVersion);
		const registered = this.db
			.prepare(
				"SELECT effective_revision FROM world_packs WHERE world_id = ? AND version = ?",
			)
			.get(row.world_id, receipt.worldVersion) as
			| { effective_revision: number }
			| undefined;
		if (registered?.effective_revision !== receipt.worldRevision)
			throw Error("Corrupt activation effective boundary");
		if (
			![1, 2, 3].includes(receipt.version) ||
			receipt.replayed !== false ||
			receipt.worldId !== row.world_id ||
			receipt.draftId !== row.draft_id ||
			receipt.draftRevision !== row.draft_revision ||
			confirmation.draftId !== row.draft_id ||
			confirmation.expectedRevision !== row.draft_revision ||
			confirmation.idempotencyKey !== row.idempotency_key ||
			receipt.inputDigest !== row.input_digest ||
			lifeDigest(confirmation) !== row.input_digest ||
			!isDeepStrictEqual(draft.pack, pack)
		)
			throw Error("Corrupt world activation provenance");
		const preview = parseWorldDraftPreview(receipt.preview);

		const { digest, ...body } = preview;
		if (
			receipt.version !== preview.version ||
			preview.version !== pack.schemaVersion ||
			digest !== lifeDigest(body) ||
			digest !== confirmation.previewDigest ||
			preview.packDigest !== confirmation.packDigest ||
			preview.packDigest !== lifeDigest(pack) ||
			!isDeepStrictEqual(preview.options, confirmation.options) ||
			preview.draftId !== draft.id ||
			preview.draftRevision !== draft.revision ||
			preview.worldId !== draft.worldId ||
			!preview.canActivate ||
			!isDeepStrictEqual(preview.unresolved, draft.unresolved)
		)
			throw Error("Corrupt world activation preview");
		const historical = this.world.snapshotAt(
				pack.worldId,
				receipt.worldRevision,
			),
			historicalLife = this.world.life.snapshotAt(
				pack.worldId,
				receipt.lifeRevision,
			);
		if (
			!isDeepStrictEqual(historical.definition, pack.world) ||
			historicalLife.worldRevision !== receipt.worldRevision ||
			historicalLife.definitionRevision !== pack.life.revision ||
			!isDeepStrictEqual(
				this.world.life.definitionAt(pack.worldId, receipt.lifeRevision),
				pack.life,
			)
		)
			throw Error("Corrupt activated world state");
		if (preview.version !== 1) {
			let autonomyMigration: AutonomyMigrationPreview | null = null;
			let migration: SocialMigrationPreview | null = null;
			if (receipt.eventId !== null) {
				const previousWorld = this.world.snapshotAt(
					pack.worldId,
					receipt.worldRevision - 1,
				);
				const previousLife = this.world.life.snapshotAt(
					pack.worldId,
					receipt.lifeRevision - 1,
				);
				const oldPack = this.worldPack(
					pack.worldId,
					previousWorld.definition.version,
				);
				const rebuilt = migrateLifeDefinitionResult(
					previousLife,
					previousWorld,
					historical,
					oldPack.life,
					pack.life,
					{ old: oldPack, next: pack },
					this.world.life.autonomyStateAt(
						pack.worldId,
						receipt.lifeRevision - 1,
					),
				);
				migration = rebuilt.socialMigration;
				autonomyMigration = rebuilt.autonomyMigration;
				if (!isDeepStrictEqual(rebuilt.state, historicalLife))
					throw Error("Corrupt activation social state");
			}
			if (
				preview.version === 3 &&
				!isDeepStrictEqual(preview.autonomyMigration, autonomyMigration)
			)
				throw Error("Corrupt activation autonomy migration preview");
			if (!isDeepStrictEqual(preview.socialMigration, migration))
				throw Error("Corrupt activation social migration preview");
		}
		const event = this.db
			.prepare(
				"SELECT event_json FROM world_events WHERE world_id = ? AND revision = ?",
			)
			.get(pack.worldId, receipt.worldRevision) as
			| { event_json: string }
			| undefined;
		if (receipt.eventId !== null) {
			const parsed = event ? JSON.parse(event.event_json) : null;
			if (
				receipt.eventId !== `${pack.worldId}:${receipt.worldRevision}` ||
				parsed?.kind !== "definition" ||
				parsed.idempotencyKey !==
					activationEventKey(pack.worldId, confirmation.idempotencyKey) ||
				!isDeepStrictEqual(parsed.definition, pack.world) ||
				!isDeepStrictEqual(parsed.relocations, confirmation.options.relocations)
			)
				throw Error("Corrupt activation event");
		} else if (
			confirmation.options.expectedWorldRevision !== null &&
			confirmation.options.expectedWorldRevision !== receipt.worldRevision
		)
			throw Error("Corrupt baseline adoption boundary");
		return receipt;
	}
	lifeConfig(worldId: string, scope?: WorldAuthorScope): LifeConfig {
		this.authorize(worldId, scope);
		this.world.snapshot(worldId);
		const row = this.db
			.prepare(
				"SELECT revision, config_json, digest FROM life_runtime_config WHERE world_id = ? ORDER BY revision DESC LIMIT 1",
			)
			.get(worldId) as
			| { revision: number; config_json: string; digest: string }
			| undefined;
		const config: LifeConfig = row
			? this.readConfig(worldId, row)
			: { ...structuredClone(EMPTY_CONFIG), worldId, revision: 0 };
		if (config.version === 2 && config.work)
			assertWorkConfigReferences(config.work, this.currentPack(worldId));
		return config;
	}
	lifeConfigAt(worldId: string, configRevision: number): LifeConfig {
		integer(configRevision, "runtime configuration revision", 1);
		const row = this.db
			.prepare(
				"SELECT revision, config_json, digest FROM life_runtime_config WHERE world_id = ? AND revision = ?",
			)
			.get(worldId, configRevision) as
			| { revision: number; config_json: string; digest: string }
			| undefined;
		if (!row) throw Error("Missing historical LIFE runtime configuration");
		return this.readConfig(worldId, row);
	}
	private readConfig(
		worldId: string,
		row: { revision: number; config_json: string; digest: string },
	): LifeConfig {
		const config = parseLifeConfigInput(JSON.parse(row.config_json));
		integer(row.revision, "runtime config revision", 1);
		if (lifeDigest(config) !== row.digest)
			throw Error("Corrupt LIFE runtime configuration");
		return { ...config, worldId, revision: row.revision };
	}
	setLifeConfig(
		worldId: string,
		expectedRevision: number,
		input: LifeConfigInput,
		scope?: WorldAuthorScope,
	): LifeConfig {
		const config = parseLifeConfigInput(input),
			current = this.lifeConfig(worldId, scope);
		integer(expectedRevision, "runtime config revision");
		if (config.version === 2 && config.work)
			assertWorkConfigReferences(config.work, this.currentPack(worldId));
		if (current.revision !== expectedRevision)
			throw Error("LIFE runtime configuration revision conflict");
		integer(expectedRevision + 1, "runtime config revision", 1);
		this.db
			.prepare(
				"INSERT INTO life_runtime_config (world_id, revision, config_json, digest) VALUES (?, ?, ?, ?)",
			)
			.run(
				worldId,
				expectedRevision + 1,
				canonicalLifeJson(config),
				lifeDigest(config),
			);
		return { ...config, worldId, revision: expectedRevision + 1 };
	}
	grantWorldAuthor(worldId: string, agentId: string): WorldAuthorGrant {
		id(worldId);
		id(agentId);
		if (
			!this.world.exists(worldId) &&
			!this.db
				.prepare("SELECT id FROM world_drafts WHERE world_id = ? LIMIT 1")
				.get(worldId)
		)
			throw Error("Unknown authoring world");
		const grant: WorldAuthorGrant = {
			version: 1,
			id: randomUUID(),
			worldId,
			agentId,
			revision: 1,
			status: "active",
		};
		this.db
			.prepare(
				"INSERT INTO world_author_grants (id, world_id, agent_id, revision, status) VALUES (?, ?, ?, ?, ?)",
			)
			.run(grant.id, worldId, agentId, grant.revision, grant.status);
		return grant;
	}
	worldAuthorGrant(grantId: string): WorldAuthorGrant {
		id(grantId);
		const row = this.db
			.prepare(
				"SELECT id, world_id, agent_id, revision, status FROM world_author_grants WHERE id = ?",
			)
			.get(grantId) as
			| {
					id: string;
					world_id: string;
					agent_id: string;
					revision: number;
					status: "active" | "revoked";
			  }
			| undefined;
		if (!row) throw Error("Unknown world author grant");
		id(row.world_id);
		id(row.agent_id);
		if (
			(row.status === "active" && row.revision !== 1) ||
			(row.status === "revoked" && row.revision !== 2) ||
			!["active", "revoked"].includes(row.status)
		)
			throw Error("Corrupt world author grant");
		if (
			!this.world.exists(row.world_id) &&
			!this.db
				.prepare("SELECT id FROM world_drafts WHERE world_id = ? LIMIT 1")
				.get(row.world_id)
		)
			throw Error("Orphan world author grant");
		return {
			version: 1,
			id: row.id,
			worldId: row.world_id,
			agentId: row.agent_id,
			revision: row.revision,
			status: row.status,
		};
	}
	revokeWorldAuthor(
		grantId: string,
		expectedRevision: number,
	): WorldAuthorGrant {
		const previous = this.worldAuthorGrant(grantId);
		integer(expectedRevision, "grant revision", 1);
		if (
			previous.status === "revoked" &&
			previous.revision === expectedRevision + 1
		)
			return previous;
		if (previous.status !== "active" || previous.revision !== expectedRevision)
			throw Error("World author grant revision conflict");
		this.db
			.prepare(
				"UPDATE world_author_grants SET status = 'revoked', revision = revision + 1 WHERE id = ?",
			)
			.run(grantId);
		return this.worldAuthorGrant(grantId);
	}
	assertActors(proposal: WorldProposal): void {
		const pack = this.currentPack(proposal.worldId);
		if (!pack) return;
		const active = new Set(
			pack.roles
				.filter((role) => role.status === "active")
				.map((role) => role.agentId),
		);
		if (proposal.actorIds.some((agent) => !active.has(agent)))
			throw Error("Retired world agent cannot act");
	}
	audit(): void {
		for (const head of this.db
			.prepare("SELECT id, world_id, revision FROM world_drafts")
			.all() as Array<{ id: string; world_id: string; revision: number }>) {
			const rows = this.db
				.prepare(
					"SELECT draft_id, revision, draft_json, digest FROM world_draft_versions WHERE draft_id = ? ORDER BY revision",
				)
				.all(head.id) as DraftRow[];
			if (rows.length !== head.revision)
				throw Error("Corrupt world draft revision history");
			for (const [index, row] of rows.entries()) {
				const draft = readDraft(row);
				if (
					draft.baseWorldVersion !== null &&
					draft.baseWorldRevision !== null &&
					(!this.world.exists(draft.worldId) ||
						this.world.snapshotAt(draft.worldId, draft.baseWorldRevision)
							.definition.version !== draft.baseWorldVersion)
				)
					throw Error("Corrupt world draft base version");
				if (draft.worldId !== head.world_id || draft.revision !== index + 1)
					throw Error("Corrupt world draft sequence");
			}
			this.worldDraft(head.id);
		}
		const activations = this.db
			.prepare("SELECT * FROM world_activations")
			.all() as ActivationRow[];
		const packs = this.db
			.prepare(
				"SELECT world_id, version, effective_revision, pack_json, digest FROM world_packs",
			)
			.all() as PackRow[];
		if (activations.length !== packs.length)
			throw Error("Orphan world activation or pack");
		const seen = new Set<string>();
		for (const row of activations) {
			const receipt = this.readActivation(row),
				key = `${receipt.worldId}:${receipt.worldVersion}`;
			if (seen.has(key)) throw Error("Ambiguous world activation");
			seen.add(key);
		}
		for (const row of packs) {
			const pack = this.decodePack(row);
			if (
				!seen.has(`${pack.worldId}:${pack.version}`) ||
				!isDeepStrictEqual(
					pack.world,
					this.world.snapshotAt(pack.worldId, row.effective_revision)
						.definition,
				)
			)
				throw Error("Corrupt pack effective boundary");
		}
		for (const row of this.db
			.prepare(
				"SELECT world_id, revision, config_json, digest FROM life_runtime_config ORDER BY world_id, revision",
			)
			.all() as Array<{
			world_id: string;
			revision: number;
			config_json: string;
			digest: string;
		}>) {
			this.readConfig(row.world_id, row);
			const count = this.db
				.prepare(
					"SELECT count(*) AS n FROM life_runtime_config WHERE world_id = ? AND revision <= ?",
				)
				.get(row.world_id, row.revision) as { n: number };
			if (count.n !== row.revision)
				throw Error("Corrupt runtime configuration sequence");
		}
		for (const row of this.db
			.prepare("SELECT id FROM world_author_grants")
			.all() as Array<{ id: string }>)
			this.worldAuthorGrant(row.id);
		for (const row of this.db
			.prepare(
				"SELECT event_json FROM world_events WHERE json_extract(event_json, '$.kind') = 'definition'",
			)
			.all() as Array<{ event_json: string }>) {
			const event = JSON.parse(row.event_json) as {
				worldId: string;
				definitionVersion: number;
				revision: number;
			};
			if (
				!packs.some(
					(pack) =>
						pack.world_id === event.worldId &&
						pack.version === event.definitionVersion &&
						pack.effective_revision === event.revision,
				)
			)
				throw Error("Orphan world definition activation");
		}
	}
}
