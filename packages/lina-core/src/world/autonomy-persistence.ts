import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { LifeConfig, WorldPack } from "./authoring-types.ts";
import { LifeModelReceipts } from "./autonomy-model-receipts.ts";
import {
	completedStepIntent,
	completedStepTarget,
} from "./autonomy-model-text.ts";
import { parsePreparedLifeModel } from "./autonomy-record-validation.ts";
import { AutonomyHistory } from "./autonomy-replay.ts";
import { LifeSchedulePersistence } from "./autonomy-schedule.ts";
import { assertAutonomySource } from "./autonomy-source.ts";
import { autonomyProfiles, LifeStepRecords } from "./autonomy-step-records.ts";
import type {
	LifePrepareRequest,
	LifeStepFailure,
} from "./autonomy-store-types.ts";
import {
	buildAutonomyOutcome,
	initialAutonomyState,
	prepareAutonomyObservation,
} from "./autonomy-transition.ts";
import type {
	AutonomySource,
	AutonomyState,
	LifeLease,
	LifeModelReconciliation,
	LifeRunStatus,
	LifeStep,
	PreparedLifeModelRequest,
} from "./autonomy-types.ts";
import { parseAutonomyState } from "./autonomy-validation.ts";
import { buildLifeModelInput } from "./autonomy-views.ts";
import { selectLifeEvent } from "./events.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type {
	IdentityPolicySnapshot,
	LifeCommit,
	LifeInput,
	LifeReceipt,
	LifeState,
} from "./life-types.ts";
import { parseIdentityPolicy } from "./life-validation.ts";
import { parseLifeResolvedModels } from "./model-selection.ts";
import type { PublicationAncestryRecord } from "./publication-ancestry.ts";
import type { PublicationBudgetSnapshot } from "./publication-budget.ts";
import type { PublicationEvidenceSnapshot } from "./publication-input.ts";
import type {
	SocialPreparedResolution,
	SocialPrepareRequest,
} from "./social-store-types.ts";
import type { SocialAutonomyInput } from "./social-types.ts";
import type { WorldSnapshot } from "./types.ts";
import { fields, integer } from "./validation.ts";
import type { WorkAncestryRecord, WorkEvidenceSnapshot } from "./work-types.ts";

type Source = { world: WorldSnapshot; life: LifeState };
type Access = {
	source(worldId: string): Source;
	sourceAt(worldId: string, lifeRevision: number): Source;
	worldAt(worldId: string, worldRevision: number): WorldSnapshot;
	pack(worldId: string, version: number): WorldPack;
	config(worldId: string): LifeConfig;
	configAt(worldId: string, revision: number): LifeConfig;
	inputs(worldId: string): LifeInput[];
	upgradeWork(worldId: string): WorkEvidenceSnapshot;
	work(worldId: string, revision?: number): WorkEvidenceSnapshot;
	workAncestry(worldId: string, lifeRevision: number): WorkAncestryRecord[];
	recordWorkStep(step: LifeStep): void;
	recordPublicationStep(step: LifeStep): void;
	publication(source: AutonomySource): PublicationEvidenceSnapshot;
	publicationBudget(source: AutonomySource): PublicationBudgetSnapshot;
	verifyPublicationBudget(source: AutonomySource, current: boolean): void;
	verifyPublication(
		source: AutonomySource,
		snapshot: PublicationEvidenceSnapshot,
	): void;
	assertPublicationCurrent(
		source: AutonomySource,
		snapshot: PublicationEvidenceSnapshot,
	): void;
	publicationAncestry(
		worldId: string,
		lifeRevision: number,
	): PublicationAncestryRecord[];
	publicationInputsAt(
		worldId: string,
		frontier: number,
		lifeRevision: number,
	): LifeInput[];
	workInputsAt(
		worldId: string,
		workRevision: number,
		lifeRevision: number,
	): LifeInput[];
	accept(commit: LifeCommit, identity: IdentityPolicySnapshot): LifeReceipt;
	social(
		worldId: string,
		requestId: string,
		source: Source,
	): SocialPreparedResolution;
};
type StateRow = {
	world_id: string;
	base_world_revision: number;
	base_life_revision: number;
	baseline_json: string;
	state_json: string;
	digest: string;
};
const TERMINAL = new Set<LifeStep["status"]>(["accepted", "failed", "stale"]);
function same(a: unknown, b: unknown, message: string): void {
	if (isDeepStrictEqual(a, b)) return;
	if (lifeDigest(a) !== lifeDigest(b)) throw Error(message);
}

/** WorldStore owns the surrounding immediate transaction. Provider work never runs here. */
export class AutonomyPersistence {
	// Reuse only the pure derivation, keyed by every input. Persistent rows and
	// current source/permission checks are still read and validated on every call.
	private lastOutcome: {
		input: string;
		value: ReturnType<typeof buildAutonomyOutcome>;
	} | null = null;
	readonly schedules: LifeSchedulePersistence;
	private readonly models: LifeModelReceipts;
	private readonly steps: LifeStepRecords;
	private readonly history: AutonomyHistory;
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: Access,
		private readonly clock: () => number,
	) {
		this.schedules = new LifeSchedulePersistence(db, clock);
		this.models = new LifeModelReceipts(db, clock);
		this.steps = new LifeStepRecords(db, this.models);
		this.history = new AutonomyHistory(db, {
			...access,
			step: (worldId, stepId) => this.steps.get(worldId, stepId),
		});
	}
	private available(): boolean {
		return (
			Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >=
			5
		);
	}
	private stateRow(worldId: string): StateRow | null {
		if (!this.available()) return null;
		return (
			(this.db
				.prepare("SELECT * FROM life_autonomy_state WHERE world_id=?")
				.get(identifier(worldId)) as StateRow | undefined) ?? null
		);
	}
	stateAt(worldId: string, lifeRevision: number): AutonomyState | null {
		return this.history.stateAt(worldId, lifeRevision);
	}
	state(worldId: string): AutonomyState | null {
		const row = this.stateRow(worldId);
		if (!row) return null;
		const state = parseAutonomyState(JSON.parse(row.state_json));
		if (state.worldId !== row.world_id || lifeDigest(state) !== row.digest)
			throw Error("Corrupt autonomy state");
		return state;
	}
	saveState(state: AutonomyState): void {
		const parsed = parseAutonomyState(state);
		this.db
			.prepare(
				"UPDATE life_autonomy_state SET state_json=?,digest=? WHERE world_id=?",
			)
			.run(canonicalLifeJson(parsed), lifeDigest(parsed), parsed.worldId);
	}
	changeDefinition(state: AutonomyState): void {
		this.saveState(state);
		this.schedules.invalidate(state.worldId);
		for (const step of this.steps.list(state.worldId)) {
			if (TERMINAL.has(step.status)) continue;
			this.models.cancelPrepared(
				state.worldId,
				step.id,
				"definition_changed_before_dispatch",
			);
			this.steps.save({
				...step,
				status: "stale",
				error: "definition_changed",
			});
		}
	}
	private initialize(
		source: Source,
		pack: AutonomySource["pack"],
		seed: number,
	): AutonomyState {
		const state = initialAutonomyState({ ...source, pack }, seed);
		this.db
			.prepare(
				"INSERT INTO life_autonomy_state(world_id,base_world_revision,base_life_revision,baseline_json,state_json,digest) VALUES(?,?,?,?,?,?)",
			)
			.run(
				state.worldId,
				state.worldRevision,
				state.lifeRevision,
				canonicalLifeJson(state),
				canonicalLifeJson(state),
				lifeDigest(state),
			);
		return state;
	}
	configure(worldId: string, configRevision: number): void {
		this.schedules.configure(worldId, configRevision);
		for (const step of this.steps.list(worldId)) {
			if (
				TERMINAL.has(step.status) ||
				step.source.config.revision === configRevision
			)
				continue;
			this.models.cancelPrepared(
				worldId,
				step.id,
				"configuration_changed_before_dispatch",
			);
			this.steps.save({
				...step,
				status: "stale",
				error: "configuration_changed",
			});
		}
	}

	invalidateWork(worldId: string): void {
		const current = this.access.work(worldId);
		const steps = this.steps
			.list(worldId)
			.filter(
				(step) =>
					!TERMINAL.has(step.status) &&
					lifeDigest(step.source.work ?? null) !== lifeDigest(current),
			);
		if (!steps.length) return;
		this.schedules.invalidate(worldId);
		for (const step of steps) {
			this.models.cancelPrepared(
				worldId,
				step.id,
				"work_changed_before_dispatch",
			);
			this.steps.save({ ...step, status: "stale", error: "work_changed" });
		}
	}
	invalidatePublication(worldId: string): void {
		const changed: LifeStep[] = [];
		for (const step of this.steps.list(worldId)) {
			if (TERMINAL.has(step.status) || !step.source.publication) continue;
			try {
				this.access.assertPublicationCurrent(
					step.source,
					step.source.publication,
				);
				this.access.verifyPublicationBudget(step.source, true);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!["Stale publication evidence", "Stale publication budget"].includes(
						error.message,
					)
				)
					throw error;
				changed.push(step);
			}
		}
		if (!changed.length) return;
		this.schedules.invalidate(worldId);
		for (const step of changed) {
			this.models.cancelPrepared(
				worldId,
				step.id,
				"publication_changed_before_dispatch",
			);
			this.steps.save({
				...step,
				status: "stale",
				error: "publication_changed",
			});
		}
	}
	invalidateIdentity(
		worldId: string,
		current: Pick<
			LifePrepareRequest,
			"identity" | "profiles" | "modelSettingsRevision"
		>,
	): void {
		identifier(worldId);
		fields(current, ["identity", "profiles", "modelSettingsRevision"]);
		const identity = parseIdentityPolicy(current.identity),
			profiles = autonomyProfiles(current.profiles),
			modelSettingsRevision = revision(current.modelSettingsRevision);
		for (const policy of identity.profiles) {
			const profile = profiles.find((p) => p.id === policy.agentId);
			if (
				!profile ||
				profile.revision !== policy.profileRevision ||
				profile.evolution !== policy.evolution
			)
				throw Error("LIFE current profile identity mismatch");
		}
		const changed = this.steps.list(worldId).filter(
			(step) =>
				!TERMINAL.has(step.status) &&
				lifeDigest({
					identity: step.source.identity,
					profiles: step.source.profiles,
					modelSettingsRevision: step.source.modelSettingsRevision,
				}) !== lifeDigest({ identity, profiles, modelSettingsRevision }),
		);
		if (!changed.length) return;
		// The installation owner invalidates old authority before aborting provider work.
		// Results may still reconcile afterward; only never-dispatched reservations are released.
		this.schedules.invalidate(worldId);
		for (const step of changed) {
			this.models.cancelPrepared(
				worldId,
				step.id,
				"identity_changed_before_dispatch",
			);
			this.steps.save({ ...step, status: "stale", error: "identity_changed" });
		}
	}
	acquireLease(
		worldId: string,
		expectedRevision: number,
		owner: string,
		leaseMs: number,
	): LifeLease {
		const config = this.access.config(worldId);
		if (config.revision !== expectedRevision)
			throw Error("LIFE schedule configuration conflict");
		return this.schedules.acquire(worldId, owner, expectedRevision, leaseMs);
	}
	status(worldId: string): LifeRunStatus {
		const source = this.access.source(worldId),
			pack = this.access.pack(worldId, source.world.definition.version),
			config = this.access.config(worldId);
		const missing: string[] = [];
		if (pack.schemaVersion !== 3) missing.push("autonomy");
		for (const key of ["clock", "run", "limits", "usage"] as const)
			if (config[key] === null) missing.push(key);
		if (!config.models?.director) missing.push("models.director");
		if (!config.models?.actor) missing.push("models.actor");
		if (config.run?.mode === "automatic" && config.clock?.intervalMs === null)
			missing.push("clock.intervalMs");
		const schedule = this.schedules.get(worldId),
			usage = this.models.usage(worldId, config);
		const pending = this.steps
			.list(worldId)
			.find((x) => !TERMINAL.has(x.status));
		const exhausted =
			!!config.usage &&
			(usage.inputTokens + usage.reservedInputTokens >=
				config.usage.maxInputTokens ||
				usage.outputTokens + usage.reservedOutputTokens >=
					config.usage.maxOutputTokens);
		return {
			worldId,
			missing,
			schedule,
			usage,
			activeStepId: pending?.id ?? null,
			status: missing.length
				? "not_configured"
				: config.run?.mode === "paused"
					? "paused"
					: usage.unknownRequests || pending?.status === "needs_attention"
						? "needs_attention"
						: pending
							? "running"
							: exhausted
								? "budget_exhausted"
								: "ready",
		};
	}
	private assertSource(
		step: LifeStep,
		source: Source,
		currentPublication = false,
	): void {
		if (step.version === 3 || step.version === 4) {
			if (!step.source.publication) throw Error("Missing publication source");
			if (currentPublication)
				this.access.assertPublicationCurrent(
					step.source,
					step.source.publication,
				);
			else this.access.verifyPublication(step.source, step.source.publication);
			this.access.verifyPublicationBudget(step.source, currentPublication);
			same(
				step.source.publicationAncestry,
				this.access.publicationAncestry(
					step.worldId,
					step.source.life.revision,
				),
				"Corrupt frozen publication ancestry",
			);
			same(
				step.source.inputs.filter((input) => input.version === 3),
				this.access.publicationInputsAt(
					step.worldId,
					step.source.publication.revision,
					step.source.life.revision,
				),
				"Corrupt frozen publication input source",
			);
		}
		if (step.source.work)
			same(
				step.source.inputs.filter(
					(input) => input.version === 2 || input.version === 4,
				),
				this.access.workInputsAt(
					step.worldId,
					step.source.work.revision,
					step.source.life.revision,
				),
				"Corrupt frozen work input source",
			);
		if (step.source.work) {
			same(
				step.source.work,
				this.access.work(step.worldId, step.source.work.revision),
				"Corrupt frozen work source",
			);
			same(
				step.source.workAncestry,
				this.access.workAncestry(step.worldId, step.source.life.revision),
				"Corrupt frozen work ancestry",
			);
		}
		same(
			step.source.world,
			source.world,
			"Stale or corrupt autonomous world source",
		);
		same(
			step.source.life,
			source.life,
			"Stale or corrupt autonomous LIFE source",
		);
		same(
			step.source.pack,
			this.access.pack(step.worldId, source.world.definition.version),
			"Corrupt autonomous pack source",
		);
		same(
			step.source.config,
			this.access.configAt(step.worldId, step.source.config.revision),
			"Corrupt autonomous configuration source",
		);
	}
	byKey(worldId: string, key: string): LifeStep | null {
		const step = this.steps.byKey(worldId, key);
		return step ? this.get(worldId, step.id) : null;
	}
	get(worldId: string, stepId: string, currentPublication = false): LifeStep {
		const step = this.steps.get(worldId, stepId);
		this.assertSource(
			step,
			this.access.sourceAt(worldId, step.source.life.revision),
			currentPublication,
		);
		same(
			step.source.autonomy,
			this.stateAt(worldId, step.source.life.revision),
			"Corrupt frozen autonomous state",
		);
		return step;
	}
	private guard(lease: LifeLease, stepId: string): LifeStep {
		this.schedules.assert(lease);
		const step = this.steps.get(lease.worldId, stepId);
		if (
			step.lease.generation !== lease.generation ||
			step.lease.token !== lease.token ||
			step.lease.owner !== lease.owner ||
			TERMINAL.has(step.status)
		)
			throw Error("Stale LIFE step lease");
		this.assertSource(step, this.access.source(step.worldId), true);
		if (step.source.work)
			same(
				step.source.work,
				this.access.work(step.worldId),
				"Stale work source",
			);
		if (
			this.access.config(step.worldId).revision !== step.source.config.revision
		)
			throw Error("Stale LIFE step configuration");
		same(
			this.state(step.worldId),
			step.source.autonomy,
			"Stale autonomous state",
		);
		return step;
	}
	prepare(value: LifePrepareRequest, entropy: () => number): LifeStep {
		fields(value, [
			...(value.resolvedModels !== undefined ? ["resolvedModels"] : []),
			"worldId",
			"idempotencyKey",
			"expectedConfigRevision",
			"owner",
			"nowMs",
			"leaseMs",
			"identity",
			"profiles",
			"modelSettingsRevision",
		]);
		identifier(value.worldId);
		identifier(value.idempotencyKey);
		identifier(value.owner);
		revision(value.expectedConfigRevision, 1);
		revision(value.modelSettingsRevision);
		revision(value.leaseMs, 1);
		revision(value.nowMs);
		const identity = parseIdentityPolicy(value.identity),
			profiles = autonomyProfiles(value.profiles);
		const resolvedModels =
			value.resolvedModels === undefined
				? undefined
				: parseLifeResolvedModels(value.resolvedModels);
		if (
			resolvedModels &&
			Object.values(resolvedModels).some(
				(r) => r !== null && r.settingsRevision !== value.modelSettingsRevision,
			)
		)
			throw Error("LIFE resolved model settings mismatch");
		const prior = this.steps.byKey(value.worldId, value.idempotencyKey);
		if (prior) {
			if (
				lifeDigest(prior.source.resolvedModels ?? null) !==
				lifeDigest(resolvedModels ?? null)
			)
				throw Error("LIFE step idempotency conflict");
			same(
				{
					identity,
					profiles,
					config: value.expectedConfigRevision,
					model: value.modelSettingsRevision,
				},
				{
					identity: prior.source.identity,
					profiles: prior.source.profiles,
					config: prior.source.config.revision,
					model: prior.source.modelSettingsRevision,
				},
				"LIFE step idempotency conflict",
			);
			if (TERMINAL.has(prior.status)) return prior;
			this.assertSource(prior, this.access.source(value.worldId), true);
			if (
				this.access.config(value.worldId).revision !==
				value.expectedConfigRevision
			)
				throw Error("LIFE configuration changed");
			const lease = this.schedules.acquire(
				value.worldId,
				value.owner,
				value.expectedConfigRevision,
				value.leaseMs,
			);
			return this.steps.save({ ...prior, lease });
		}
		const status = this.status(value.worldId);
		if (status.status !== "ready")
			throw Error(`LIFE ${status.status}: ${status.missing.join(",")}`);
		const current = this.access.source(value.worldId),
			pack = this.access.pack(value.worldId, current.world.definition.version),
			config = this.access.config(value.worldId);
		if (
			pack.schemaVersion !== 3 ||
			config.revision !== value.expectedConfigRevision
		)
			throw Error("LIFE configuration conflict");
		for (const role of pack.roles) {
			const profile = profiles.find((x) => x.id === role.agentId),
				policy = identity.profiles.find((x) => x.agentId === role.agentId);
			if (
				!profile ||
				!policy ||
				profile.revision !== policy.profileRevision ||
				profile.evolution !== policy.evolution
			)
				throw Error("LIFE profile identity mismatch");
		}
		const id = `step-${lifeDigest([value.worldId, value.idempotencyKey]).slice(0, 48)}`;
		const existing = this.state(value.worldId);
		const source: AutonomySource = {
			...(resolvedModels ? { resolvedModels } : {}),
			work: resolvedModels
				? this.access.upgradeWork(value.worldId)
				: this.access.work(value.worldId),
			workAncestry: this.access.workAncestry(
				value.worldId,
				current.life.revision,
			),
			...current,
			pack,
			config,
			identity,
			profiles,
			autonomy: existing ?? initialAutonomyState({ ...current, pack }, 0),
			inputs: this.access.inputs(value.worldId),
			modelSettingsRevision: value.modelSettingsRevision,
		};
		source.publication = this.access.publication(source);
		source.publicationAncestry = this.access.publicationAncestry(
			value.worldId,
			current.life.revision,
		);
		source.publicationBudget = this.access.publicationBudget(source);
		assertAutonomySource(source);
		selectLifeEvent(source, id);
		if (!existing) {
			const seed = entropy();
			integer(seed, "autonomy seed", 0, 0xffffffff);
			source.autonomy = this.initialize(current, pack, seed);
		}
		const decision = selectLifeEvent(source, id),
			lease = this.schedules.acquire(
				value.worldId,
				value.owner,
				config.revision,
				value.leaseMs,
			);
		return this.steps.save({
			version: resolvedModels ? 4 : 3,
			id,
			worldId: value.worldId,
			idempotencyKey: value.idempotencyKey,
			status: "prepared",
			source,
			decision,
			lease,
			models: [],
			intent: null,
			targetResponse: null,
			socialRequestId: null,
			reflectionAgentIds: null,
			outcome: null,
			receipt: null,
			error: null,
		});
	}
	private social(step: LifeStep): SocialPreparedResolution | null {
		if (!step.socialRequestId) return null;
		const social = this.access.social(
			step.worldId,
			step.socialRequestId,
			step.source,
		);
		// The replay validator consumes the staged result, before its accepted marker was written.
		return { ...social, acceptedLifeRevision: null };
	}
	private assertUsage(step: LifeStep): void {
		if (step.models.length > step.decision.maxModelCalls)
			throw Error("LIFE model call budget exceeded");
		for (const model of step.models) {
			const usage = model.usage;
			if (
				model.status !== "completed" ||
				usage.inputTokens === null ||
				usage.outputTokens === null ||
				usage.totalTokens === null ||
				usage.inputTokens > model.reservation.inputTokens ||
				usage.outputTokens > model.reservation.outputTokens
			)
				throw Error("LIFE model usage unknown or exceeds reservation");
		}
	}
	private assertModel(
		step: LifeStep,
		prepared: PreparedLifeModelRequest,
	): void {
		const r = prepared.request;
		if (r.lane === "publication")
			throw Error("Invalid step model request owner");
		if (step.version === 4) {
			if (r.version !== 3)
				throw Error("Frozen step requires selected model request");
			same(
				r.selection,
				step.source.resolvedModels?.[
					r.lane === "director" ? "director" : "actor"
				],
				"Frozen step model selection mismatch",
			);
		} else if (r.version !== 1)
			throw Error("Legacy step requires legacy model request");
		const route =
			step.version === 4
				? step.source.resolvedModels?.[
						r.lane === "director" ? "director" : "actor"
					]
				: step.source.config.models?.[
						r.lane === "director" ? "director" : "actor"
					];
		if (route && "tier" in route)
			throw Error("Tier route requires frozen LIFE owner");
		if (
			step.decision.kind !== "event" ||
			r.stepId !== step.id ||
			r.worldId !== step.worldId ||
			r.provider !== route?.provider ||
			r.model !== route.model ||
			r.modelSettingsRevision !== step.source.modelSettingsRevision
		)
			throw Error("LIFE model route or source mismatch");
		const observation =
			r.lane === "reflection"
				? prepareAutonomyObservation(step, this.social(step))
				: undefined;
		const prompt = buildLifeModelInput(step, r.lane, r.agentId, observation);
		same(
			{ systemPrompt: r.systemPrompt, input: r.input },
			prompt,
			"LIFE model input differs from scoped source",
		);
	}
	prepareModel(
		lease: LifeLease,
		stepId: string,
		value: PreparedLifeModelRequest,
	) {
		const step = this.guard(lease, stepId),
			prepared = parsePreparedLifeModel(value),
			r = prepared.request;
		if (r.lane === "publication")
			throw Error("Invalid step model request owner");
		this.assertModel(step, prepared);
		const existing = step.models.find((x) => x.prepared.request.id === r.id);
		if (!existing) this.assertUsage(step);
		if (
			!existing &&
			(step.models.length >= step.decision.maxModelCalls ||
				step.models.some(
					(x) =>
						x.prepared.request.lane === r.lane &&
						x.prepared.request.agentId === r.agentId,
				))
		)
			throw Error("LIFE model call budget or duplicate lane");
		const record = this.models.prepare(prepared, step.source.config);
		this.steps.save({ ...step, status: "running", error: null });
		return record;
	}
	dispatchModel(lease: LifeLease, stepId: string, requestId: string) {
		const step = this.guard(lease, stepId);
		return this.models.dispatch(
			lease.worldId,
			stepId,
			requestId,
			step.source.config,
		);
	}
	assertModelOutbound(
		request: import("./autonomy-types.ts").LifeModelRequest,
	): void {
		if (request.lane === "publication")
			throw Error("Invalid step model request owner");
		const saved = this.steps.get(request.worldId, request.stepId);
		const step = this.guard(saved.lease, saved.id);
		if (request.version !== (step.version === 4 ? 3 : 1))
			throw Error("Outbound LIFE request version differs from step");
		if (request.version === 3)
			same(
				request.selection,
				step.source.resolvedModels?.[
					request.lane === "director" ? "director" : "actor"
				],
				"Outbound LIFE selection differs from step",
			);
		this.models.assertOutbound(request, step.source.config);
	}
	finishModel(
		worldId: string,
		stepId: string,
		requestId: string,
		value: LifeModelReconciliation,
	) {
		this.steps.get(worldId, stepId);
		return this.models.finish(worldId, stepId, requestId, value);
	}
	intention(lease: LifeLease, stepId: string): LifeStep {
		const step = this.guard(lease, stepId),
			intent = completedStepIntent(step).intent;
		return this.steps.save({ ...step, intent });
	}
	target(lease: LifeLease, stepId: string): LifeStep {
		const step = this.guard(lease, stepId),
			targetResponse = completedStepTarget(
				step,
				completedStepIntent(step).intent,
			);
		return this.steps.save({ ...step, targetResponse });
	}
	socialAuthority(
		request: SocialPrepareRequest,
		source: Source,
		historical: boolean,
	): SocialAutonomyInput | null {
		if (request.version === 1) {
			if (historical) return null;
			if (
				this.state(request.worldId) &&
				source.life.revision >=
					(this.stateRow(request.worldId)?.base_life_revision ?? 0)
			)
				throw Error("Autonomous LIFE step required");
			return null;
		}
		const step = this.steps.get(request.worldId, request.stepId);
		if (!historical) this.guard(step.lease, step.id);
		this.assertSource(step, source);
		same(request.intent, step.intent, "Autonomous social intention mismatch");
		same(
			request.targetResponse,
			step.targetResponse,
			"Autonomous social target mismatch",
		);
		same(
			request.identity,
			step.source.identity,
			"Autonomous social identity mismatch",
		);
		if (request.simulationTime !== step.decision.simulationTime || !step.intent)
			throw Error("Autonomous social time mismatch");
		return {
			stepId: step.id,
			worldRevision: source.world.revision,
			lifeRevision: source.life.revision,
			stateDigest: lifeDigest(step.source.autonomy),
			variables: structuredClone(step.source.autonomy.variables),
		};
	}
	observations(
		lease: LifeLease,
		stepId: string,
		socialRequestId: string | null,
	): LifeStep {
		const step = this.guard(lease, stepId);
		if (
			step.socialRequestId !== null &&
			step.socialRequestId !== socialRequestId
		)
			throw Error("LIFE social request conflict");
		const staged = { ...step, socialRequestId };
		const observation = prepareAutonomyObservation(staged, this.social(staged));
		if (step.reflectionAgentIds !== null)
			same(
				step.reflectionAgentIds,
				observation.agentIds,
				"LIFE observation conflict",
			);
		return this.steps.save({
			...staged,
			reflectionAgentIds: observation.agentIds,
		});
	}
	finish(lease: LifeLease, stepId: string): LifeStep {
		const step = this.guard(lease, stepId);
		this.assertUsage(step);
		const outcome = buildAutonomyOutcome(step, this.social(step));
		if (step.outcome) same(step.outcome, outcome, "LIFE outcome conflict");
		return this.steps.save({ ...step, status: "ready", outcome, error: null });
	}
	assertCommit(
		commit: LifeCommit,
		identity: IdentityPolicySnapshot,
		source: Source,
		historical: boolean,
	): void {
		if (commit.version !== 3) {
			const baseline = this.stateRow(commit.world.worldId);
			if (
				baseline &&
				commit.expectedLifeRevision >= baseline.base_life_revision
			)
				throw Error("Autonomous LIFE commit required");
			return;
		}
		const step = this.steps.get(commit.world.worldId, commit.stepId);
		this.assertSource(step, source);
		if (historical ? step.status !== "accepted" : step.status !== "ready")
			throw Error("LIFE step is not ready for commit");
		same(identity, step.source.identity, "Autonomous identity mismatch");
		this.assertUsage(step);
		const social = this.social(step);
		const input = canonicalLifeJson([step, social]);
		let expected =
			this.lastOutcome?.input === input ? this.lastOutcome.value : null;
		if (!expected) {
			expected = buildAutonomyOutcome(step, social);
			this.lastOutcome = { input, value: expected };
		}
		same(
			commit,
			expected.commit,
			"Autonomous receipt does not authorize commit",
		);
		same(step.outcome, expected, "Corrupt autonomous outcome");
	}
	accept(
		lease: LifeLease,
		stepId: string,
		current: {
			identity: IdentityPolicySnapshot;
			modelSettingsRevision: number;
		},
	): LifeReceipt {
		const prior = this.steps.get(lease.worldId, stepId);
		if (prior.status === "accepted" && prior.receipt)
			return { ...prior.receipt, replayed: true };
		const step = this.guard(lease, stepId);
		same(
			parseIdentityPolicy(current.identity),
			step.source.identity,
			"LIFE identity changed",
		);
		if (current.modelSettingsRevision !== step.source.modelSettingsRevision)
			throw Error("LIFE model settings changed");
		if (step.status !== "ready" || !step.outcome)
			throw Error("LIFE step not ready");
		const receipt = this.access.accept(
			step.outcome.commit,
			step.source.identity,
		);
		this.saveState(step.outcome.nextState);
		this.steps.save({ ...step, status: "accepted", receipt, error: null });
		this.access.recordWorkStep({ ...step, status: "accepted", receipt });
		this.access.recordPublicationStep({ ...step, status: "accepted", receipt });
		this.schedules.accepted(lease, step.id);
		return receipt;
	}
	fail(lease: LifeLease, stepId: string, reason: LifeStepFailure): LifeStep {
		const step = this.guard(lease, stepId);
		if (
			![
				"invalid_model_output",
				"model_unknown",
				"budget",
				"cancelled",
				"stale",
				"engine_error",
				"unavailable",
			].includes(reason)
		)
			throw Error("Invalid LIFE failure reason");
		const status =
			reason === "stale"
				? "stale"
				: reason === "invalid_model_output"
					? "failed"
					: "needs_attention";
		if (status === "stale" || status === "failed")
			this.models.cancelPrepared(
				step.worldId,
				step.id,
				`${reason}_before_dispatch`,
			);
		return this.steps.save({ ...step, status, error: reason });
	}
	acceptedSteps(): LifeStep[] {
		return this.steps.list().filter((step) => step.status === "accepted");
	}
	audit(): void {
		this.schedules.audit();
		this.models.audit();
		for (const step of this.steps.list()) {
			this.assertSource(
				step,
				this.access.sourceAt(step.worldId, step.source.life.revision),
			);
			same(
				step.source.autonomy,
				this.stateAt(step.worldId, step.source.life.revision),
				"Corrupt frozen autonomous state",
			);
			for (const model of step.models) this.assertModel(step, model.prepared);
			if (step.outcome) {
				this.assertUsage(step);
				same(
					step.outcome,
					buildAutonomyOutcome(step, this.social(step)),
					"Corrupt autonomous outcome",
				);
			}
		}
		for (const row of this.db
			.prepare("SELECT world_id FROM life_autonomy_state")
			.all()) {
			const worldId = identifier(row["world_id"]),
				source = this.access.source(worldId);
			same(
				this.state(worldId),
				this.stateAt(worldId, source.life.revision),
				"Corrupt autonomous state checkpoint",
			);
		}
	}
}
