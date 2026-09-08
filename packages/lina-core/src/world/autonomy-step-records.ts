import type { DatabaseSync } from "node:sqlite";
import type { AgentProfile } from "../agents/types.ts";
import { validateAgentInput } from "../agents/validation.ts";
import {
	parseLifeConfigInput,
	parseWorldPack,
} from "./authoring-validation.ts";
import type { LifeModelReceipts } from "./autonomy-model-receipts.ts";
import {
	completedStepIntent,
	completedStepTarget,
} from "./autonomy-model-text.ts";
import { parseLifeLease } from "./autonomy-record-validation.ts";
import { assertAutonomySource } from "./autonomy-source.ts";
import type { AutonomySource, LifeStep } from "./autonomy-types.ts";
import { parseAutonomyState } from "./autonomy-validation.ts";
import { selectLifeEvent } from "./events.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import {
	parseIdentityPolicy,
	parseLifeCommit,
	parseLifeInput,
	parseLifeState,
} from "./life-validation.ts";
import { parsePublicationAncestry } from "./publication-ancestry.ts";
import { parsePublicationBudget } from "./publication-budget.ts";
import { parsePublicationEvidence } from "./publication-input.ts";
import { fields } from "./validation.ts";
import { parseWorkAncestry } from "./work-ancestry.ts";
import { parseWorkEvidence } from "./work-validation.ts";

type Row = {
	world_id: string;
	step_id: string;
	idempotency_key: string;
	source_world_revision: number;
	source_life_revision: number;
	step_json: string;
	digest: string;
	accepted_life_revision: number | null;
};
export function autonomyProfiles(value: unknown): AgentProfile[] {
	if (!Array.isArray(value)) throw Error("Missing LIFE profiles");
	const result = value.map((raw: unknown) => {
		fields(raw, [
			"id",
			"name",
			"role",
			"personality",
			"voice",
			"profile",
			"appearance",
			"interests",
			"avatarId",
			"evolution",
			"revision",
		]);
		const { revision: version, ...input } = raw;
		return { ...validateAgentInput(input), revision: revision(version, 1) };
	});
	if (new Set(result.map((p) => p.id)).size !== result.length)
		throw Error("Duplicate LIFE profiles");
	return result;
}

/** Structural validation plus deterministic decision verification; source history is checked by the parent. */
export class LifeStepRecords {
	constructor(
		private readonly db: DatabaseSync,
		private readonly models: LifeModelReceipts,
	) {}
	private decode(row: Row): LifeStep {
		const raw: unknown = JSON.parse(row.step_json);
		fields(raw, [
			"version",
			"id",
			"worldId",
			"idempotencyKey",
			"status",
			"source",
			"decision",
			"lease",
			"models",
			"intent",
			"targetResponse",
			"socialRequestId",
			"reflectionAgentIds",
			"outcome",
			"receipt",
			"error",
		]);
		const s = raw.source;
		fields(s, [
			"world",
			"life",
			"pack",
			"config",
			"identity",
			"profiles",
			"autonomy",
			"inputs",
			"modelSettingsRevision",
			...(raw.version === 2 || raw.version === 3
				? ["work", "workAncestry"]
				: []),
			...(raw.version === 3
				? ["publication", "publicationAncestry", "publicationBudget"]
				: []),
		]);
		fields(s["config"], [
			"version",
			"worldId",
			"revision",
			"clock",
			"run",
			"models",
			"limits",
			"usage",
			"publication",
			"images",
			"avatars",
			...(typeof s["config"] === "object" &&
			s["config"] !== null &&
			"version" in s["config"] &&
			s["config"].version === 2
				? ["work"]
				: []),
		]);
		const {
			worldId: configWorldId,
			revision: configRevision,
			...config
		} = s["config"];
		const pack = parseWorldPack(s["pack"]);
		if (pack.schemaVersion !== 3) throw Error("Corrupt autonomous world pack");
		if (!Array.isArray(s["inputs"])) throw Error("Corrupt autonomous inputs");
		const source: AutonomySource = {
			...(raw.version === 2 || raw.version === 3
				? {
						work: parseWorkEvidence(s["work"]),
						workAncestry: parseWorkAncestry(s["workAncestry"]),
					}
				: {}),
			...(raw.version === 3
				? {
						publication: parsePublicationEvidence(s["publication"]),
						publicationBudget: parsePublicationBudget(s["publicationBudget"]),
						publicationAncestry: parsePublicationAncestry(
							s["publicationAncestry"],
						),
					}
				: {}),
			world: s["world"] as AutonomySource["world"],
			life: parseLifeState(s["life"]),
			pack,
			config: {
				...parseLifeConfigInput(config),
				worldId: identifier(configWorldId),
				revision: revision(configRevision, 1),
			},
			identity: parseIdentityPolicy(s["identity"]),
			profiles: autonomyProfiles(s["profiles"]),
			autonomy: parseAutonomyState(s["autonomy"]),
			inputs: s["inputs"].map(parseLifeInput),
			modelSettingsRevision: revision(s["modelSettingsRevision"]),
		};
		if (raw.version !== 3 && source.inputs.some((input) => input.version === 3))
			throw Error("Legacy step cannot carry publication input");
		assertAutonomySource(source);
		const step = raw as unknown as LifeStep;
		if (
			(raw.version !== 1 && raw.version !== 2 && raw.version !== 3) ||
			row.world_id !== identifier(raw.worldId) ||
			row.step_id !== identifier(raw.id) ||
			row.idempotency_key !== identifier(raw.idempotencyKey) ||
			row.digest !== lifeDigest(raw) ||
			revision(row.source_world_revision) !== source.world.revision ||
			revision(row.source_life_revision) !== source.life.revision ||
			!Array.isArray(raw.models) ||
			raw.models.length ||
			![
				"prepared",
				"running",
				"ready",
				"accepted",
				"needs_attention",
				"failed",
				"stale",
			].includes(step.status)
		)
			throw Error("Corrupt LIFE step provenance");
		const baseline = this.db
			.prepare(
				"SELECT base_world_revision, base_life_revision FROM life_autonomy_state WHERE world_id=?",
			)
			.get(step.worldId) as
			| { base_world_revision: number; base_life_revision: number }
			| undefined;
		if (
			!baseline ||
			revision(baseline.base_world_revision) > source.world.revision ||
			revision(baseline.base_life_revision) > source.life.revision
		)
			throw Error("Missing or corrupt autonomy baseline");
		step.source = source;
		step.lease = parseLifeLease(raw.lease);
		if (
			step.lease.worldId !== step.worldId ||
			source.config.worldId !== step.worldId ||
			source.world.definition.id !== step.worldId ||
			lifeDigest(selectLifeEvent(source, step.id)) !== lifeDigest(step.decision)
		)
			throw Error("Corrupt autonomous decision");
		step.models = this.models.list(step.worldId, step.id);
		if (
			step.intent !== null &&
			lifeDigest(completedStepIntent(step).intent) !== lifeDigest(step.intent)
		)
			throw Error("Corrupt autonomous intention");
		if (
			step.targetResponse !== null &&
			lifeDigest(
				completedStepTarget(step, completedStepIntent(step).intent),
			) !== lifeDigest(step.targetResponse)
		)
			throw Error("Corrupt autonomous target");
		if (step.socialRequestId !== null) identifier(step.socialRequestId);
		if (step.reflectionAgentIds !== null) {
			if (
				!Array.isArray(step.reflectionAgentIds) ||
				new Set(step.reflectionAgentIds).size !== step.reflectionAgentIds.length
			)
				throw Error("Corrupt LIFE reflection recipients");
			step.reflectionAgentIds.forEach(identifier);
		}
		if (step.error !== null && typeof step.error !== "string")
			throw Error("Corrupt LIFE error");
		if (step.outcome !== null) {
			fields(step.outcome, [
				"version",
				"stepId",
				"kind",
				"commit",
				"nextState",
			]);
			if (
				step.outcome.version !== 1 ||
				step.outcome.stepId !== step.id ||
				![
					"quiet",
					"work",
					...(step.version === 3 ? ["feedback"] : []),
					"activity",
					"extension_required",
				].includes(step.outcome.kind)
			)
				throw Error("Corrupt LIFE outcome");
			parseLifeCommit(step.outcome.commit);
			parseAutonomyState(step.outcome.nextState);
		}
		if (
			(step.status === "accepted") !== (step.receipt !== null) ||
			(step.receipt === null
				? null
				: revision(step.receipt.lifeRevision, 1)) !==
				row.accepted_life_revision ||
			((step.status === "ready" || step.status === "accepted") &&
				step.outcome === null)
		)
			throw Error("Corrupt LIFE step acceptance");
		if (step.receipt !== null) {
			if (!step.outcome) throw Error("Missing autonomous acceptance outcome");
			const envelope = {
				version: 1,
				commit: step.outcome.commit,
				identity: step.source.identity,
			};
			const expected = {
				worldId: step.worldId,
				eventId: `${step.worldId}:${step.source.world.revision + 1}`,
				worldRevision: step.source.world.revision + 1,
				lifeRevision: step.source.life.revision + 1,
				inputDigest: lifeDigest(envelope),
				identity: step.source.identity,
				replayed: false,
			};
			const paired = this.db
				.prepare(
					"SELECT envelope_json,input_digest FROM life_commits WHERE world_id=? AND life_revision=?",
				)
				.get(step.worldId, expected.lifeRevision) as
				| { envelope_json: string; input_digest: string }
				| undefined;
			if (
				lifeDigest(step.receipt) !== lifeDigest(expected) ||
				!paired ||
				paired.input_digest !== expected.inputDigest ||
				lifeDigest(JSON.parse(paired.envelope_json)) !== expected.inputDigest
			)
				throw Error("Corrupt autonomous acceptance receipt");
		}
		return step;
	}
	get(worldId: string, stepId: string): LifeStep {
		const row = this.db
			.prepare("SELECT * FROM life_steps WHERE world_id=? AND step_id=?")
			.get(identifier(worldId), identifier(stepId)) as Row | undefined;
		if (!row) throw Error("Unknown LIFE step");
		return this.decode(row);
	}
	byKey(worldId: string, key: string): LifeStep | null {
		const row = this.db
			.prepare(
				"SELECT * FROM life_steps WHERE world_id=? AND idempotency_key=?",
			)
			.get(identifier(worldId), identifier(key)) as Row | undefined;
		return row ? this.decode(row) : null;
	}
	list(worldId?: string): LifeStep[] {
		const query = this.db.prepare(
			`SELECT * FROM life_steps${worldId === undefined ? "" : " WHERE world_id=?"} ORDER BY rowid`,
		);
		return (
			worldId === undefined ? query.all() : query.all(identifier(worldId))
		).map((row) => this.decode(row as Row));
	}
	save(step: LifeStep): LifeStep {
		const value = { ...step, models: [] };
		this.db
			.prepare(
				"INSERT INTO life_steps(world_id,step_id,idempotency_key,source_world_revision,source_life_revision,step_json,digest,accepted_life_revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(world_id,step_id) DO UPDATE SET step_json=excluded.step_json,digest=excluded.digest,accepted_life_revision=excluded.accepted_life_revision",
			)
			.run(
				step.worldId,
				step.id,
				step.idempotencyKey,
				step.source.world.revision,
				step.source.life.revision,
				canonicalLifeJson(value),
				lifeDigest(value),
				step.receipt?.lifeRevision ?? null,
			);
		return this.get(step.worldId, step.id);
	}
}
