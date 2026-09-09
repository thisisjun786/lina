import { join } from "node:path";
import { createCodexLifeModel } from "../../../lina-codex/src/life-model.ts";
import type { CodexLifeModelOptions } from "../../../lina-codex/src/life-model-policy.ts";
import type { CurrentBehaviorProjection } from "../../../lina-core/src/agents/behavior-types.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { IdentityPolicySnapshot } from "../../../lina-core/src/world/life-types.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../../lina-core/src/world/publication-model.ts";
import type { PublicationAuthor } from "../../../lina-core/src/world/publication-types.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import {
	projectCurrentPersona,
	projectSharedPersona,
} from "../../../lina-core/src/world/views.ts";
import { resolveLifeModelProfile } from "../life/model-selection.ts";
import type { LifeForeground } from "../life/runner.ts";
import { createLifeRuntime, systemLifeClock } from "../life/runtime.ts";
import type { LifeClock } from "../life/scheduler.ts";
import { createEnsembleSocialEngine } from "../life/social/ensemble.ts";
import {
	createWorkBridge,
	type WorkBridgeSource,
} from "../life/work-bridge.ts";
import { assertWorkSourceCurrent } from "../life/work-source.ts";
import type { ModelSettingsStore } from "../models/settings.ts";
import type { FleetLifeImages } from "./life-images.ts";

export interface FleetLifeContext {
	personalGrowth?: (
		worldId: string,
		agentId: string,
	) => CurrentBehaviorProjection;
	store: WorldStore;
	agents: AgentStore;
	modelSettings: ModelSettingsStore;
	foreground: LifeForeground;
}
export interface FleetLifeOptions extends FleetLifeContext {
	workSource?: WorkBridgeSource;
	stateRoot: string;
	connection(): ReturnType<CodexLifeModelOptions["selection"]>["connection"];
	providerEnv: NonNullable<CodexLifeModelOptions["providerEnv"]>;
	clock?: LifeClock;
	command?: string;
	/** Image owner shares this scheduler and lifecycle; client configuration remains fleet-owned. */
	images?: FleetLifeImages;
	/** Trusted composition seam, inaccessible to HTTP and ordinary tools. */
	createModel?: typeof createCodexLifeModel;
}

export function fleetLifeIdentity(
	store: WorldStore,
	agents: AgentStore,
	worldId: string,
	personalGrowth?: FleetLifeContext["personalGrowth"],
	version: 1 | 2 = personalGrowth ? 2 : 1,
) {
	const definition = store.lifeDefinition(worldId);
	const profiles = definition.participants.map((id) => {
		const profile = agents.get(id);
		if (!profile) throw Error("LIFE participant profile unavailable");
		return profile;
	});
	const identity: IdentityPolicySnapshot = {
		version: 1,
		profiles: profiles.map((profile) => ({
			agentId: profile.id,
			profileRevision: profile.revision,
			evolution: profile.evolution,
			lockedTraitIds:
				profile.evolution === "manual"
					? definition.traits.map((axis) => axis.id)
					: [],
			lockedHabitIds:
				profile.evolution === "manual"
					? definition.habits.map((axis) => axis.id)
					: [],
			lockedAttitudeIds:
				profile.evolution === "manual"
					? definition.attitudes.map((axis) => axis.id)
					: [],
		})),
	};
	if (version === 1) return { identity, profiles };
	const current: IdentityPolicySnapshot = {
		version: 2,
		profiles: identity.profiles.map((profile) => {
			const personal = personalGrowth?.(worldId, profile.agentId);
			return {
				...profile,
				personalBehavior: personal?.personalBehavior ?? null,
				sourceStamp: personal?.sourceStamp ?? null,
			};
		}),
	};
	return { identity: current, profiles };
}

/** Explicit public voice and shared growth only; biography, private dynamics and event rationale stay out. */
export function fleetPublicationAuthor(
	store: WorldStore,
	agents: AgentStore,
	worldId: string,
	agentId: string,
	personalGrowth?: FleetLifeContext["personalGrowth"],
	version: 1 | 2 = personalGrowth ? 2 : 1,
): PublicationAuthor {
	const profile = agents.get(agentId),
		definition = store.lifeDefinition(worldId),
		limits = store.lifeConfig(worldId).limits?.evaluation;
	if (
		!profile ||
		!store.activePublicationAgents(worldId).includes(agentId) ||
		!limits
	)
		throw Error("Publication author unavailable");
	const shared = projectSharedPersona(
		store.lifeSnapshot(worldId),
		definition,
		{
			version: 1,
			worldId,
			agentId,
			revision: 1,
			projectionPolicyRevision: definition.projection.revision,
		},
		fleetLifeIdentity(store, agents, worldId).identity,
		{ maxChars: limits.maxChars, maxRecords: limits.maxRecords },
	);
	if (!shared) throw Error("Publication shared persona unavailable");
	const author = {
		agentId,
		name: profile.name,
		voice: profile.voice,
		profileRevision: profile.revision,
		behavior: {
			traits: shared.traits,
			habits: shared.habits,
			attitudes: shared.attitudes,
		},
	};
	if (version === 1) return author;
	const current = projectCurrentPersona(
		store.lifeSnapshot(worldId),
		definition,
		{
			version: 1,
			worldId,
			agentId,
			revision: 1,
			projectionPolicyRevision: definition.projection.revision,
		},
		fleetLifeIdentity(store, agents, worldId, personalGrowth, 2).identity,
		{ maxChars: limits.maxChars, maxRecords: limits.maxRecords },
	);
	if (!current) throw Error("Publication persona unavailable");
	return {
		version: 2,
		...author,
		behavior: current.composedBehavior,
		sourceStamp: current.sourceStamp,
	};
}

/** One installation owns this runtime and its native transport; store ownership stays in fleet. */
export function createFleetLifeRuntime(options: FleetLifeOptions) {
	const { store, agents, modelSettings, foreground, images } = options;
	const publicationAuthor = (
		worldId: string,
		agentId: string,
		frozen?: PublicationAuthor | null,
	) =>
		fleetPublicationAuthor(
			store,
			agents,
			worldId,
			agentId,
			options.personalGrowth,
			frozen && !("version" in frozen) ? 1 : options.personalGrowth ? 2 : 1,
		);
	const clock = options.clock ?? systemLifeClock;
	const bridge = options.workSource
		? createWorkBridge({
				source: options.workSource,
				world: store,
				// Delivery attempts are durably visible in task management; never log task content.
				onError() {},
			})
		: undefined;
	const catalog = () => {
		const entries: ReturnType<WorldStore["worldCatalog"]>["items"] = [];
		let afterId: string | null = null;
		do {
			const page = store.worldCatalog({ afterId, limit: 100 });
			entries.push(...page.items);
			afterId = page.nextCursor;
		} while (afterId !== null);
		return entries;
	};
	const worldIds = () =>
		catalog()
			.filter(
				(entry) =>
					entry.packVersion !== null &&
					store.worldPack(entry.worldId).schemaVersion === 3 &&
					store.lifeConfig(entry.worldId).revision > 0,
			)
			.map((entry) => entry.worldId);
	const publicationWorldIds = () =>
		catalog()
			.filter(
				(entry) =>
					store.lifeConfig(entry.worldId).publication !== null &&
					store.publicationSettings(entry.worldId) !== null,
			)
			.map((entry) => entry.worldId);
	const imageWorldIds = () =>
		catalog()
			.filter(
				(entry) =>
					store.imageSettings(entry.worldId) !== null ||
					store.imageAttempts(entry.worldId).length > 0,
			)
			.map((entry) => entry.worldId);
	const model = (options.createModel ?? createCodexLifeModel)({
		stateRoot: join(options.stateRoot, "life", "model"),
		providerEnv: options.providerEnv,
		...(options.command ? { command: options.command } : {}),
		beforeOutbound(request) {
			if (request.version === 1) {
				store.assertLifeModelOutbound(request);
				assertWorkSourceCurrent(
					options.workSource,
					store.lifeStep(request.worldId, request.stepId).source.work,
				);
				return;
			}
			store.assertPublicationOutbound(
				request,
				publicationAuthor(
					request.worldId,
					request.agentId,
					store.publicationJob(request.worldId, request.jobId).author,
				),
				modelSettings.snapshot().revision,
			);
			assertWorkSourceCurrent(
				options.workSource,
				store.workEvidence(request.worldId),
			);
		},
		selection(request) {
			const config = store.lifeConfig(request.worldId);
			if (request.version === 2) {
				const job = store.assertPublicationDispatch(
					request.worldId,
					request.jobId,
					publicationAuthor(
						request.worldId,
						request.agentId,
						store.publicationJob(request.worldId, request.jobId).author,
					),
					modelSettings.snapshot().revision,
				);
				if (
					request.id !== publicationModelId(job.attemptId) ||
					request.agentId !== job.authorAgentId ||
					lifeDigest({
						systemPrompt: request.systemPrompt,
						input: request.input,
					}) !== lifeDigest(buildPublicationModelInput(job))
				)
					throw Error("Publication model differs from owned source");
				assertWorkSourceCurrent(
					options.workSource,
					store.workEvidence(request.worldId),
				);
			} else {
				const step = store.lifeStep(request.worldId, request.stepId);
				if (
					["accepted", "failed", "stale", "needs_attention"].includes(
						step.status,
					) ||
					lifeDigest(config) !== lifeDigest(step.source.config) ||
					store.snapshot(request.worldId).revision !==
						step.source.world.revision ||
					store.lifeSnapshot(request.worldId).revision !==
						step.source.life.revision ||
					(step.source.work &&
						lifeDigest(store.workEvidence(request.worldId)) !==
							lifeDigest(step.source.work)) ||
					lifeDigest(
						fleetLifeIdentity(
							store,
							agents,
							request.worldId,
							options.personalGrowth,
							step.source.identity.version,
						),
					) !==
						lifeDigest({
							identity: step.source.identity,
							profiles: step.source.profiles,
						})
				)
					throw Error(
						"LIFE destination or source snapshot changed before model dispatch",
					);
				assertWorkSourceCurrent(options.workSource, step.source.work);
				store.assertPublicationEvidenceCurrent(request.worldId, request.stepId);
			}
			const settings = modelSettings.snapshot();
			const route =
				config.models?.[request.lane === "director" ? "director" : "actor"];
			if (
				settings.revision !== request.modelSettingsRevision ||
				route?.provider !== request.provider ||
				route.model !== request.model
			)
				throw Error("LIFE exact model/settings selection changed");
			return {
				connection: options.connection(),
				selected: resolveLifeModelProfile(settings, route),
				settingsRevision: settings.revision,
			};
		},
	});
	const failures = new Map<string, "scheduler_unavailable">();
	const runtime = createLifeRuntime({
		store,
		model,
		foreground,
		clock,
		engine: createEnsembleSocialEngine(),
		worldIds,
		publicationWorldIds,
		...(images
			? {
					imageWorldIds,
					visitImages: (worldId: string, signal: AbortSignal) =>
						images.visit(worldId, signal),
				}
			: {}),
		beforePrepare: () => {
			bridge?.poll();
		},
		assertSourceCurrent: (step) =>
			assertWorkSourceCurrent(options.workSource, step.source.work),
		publication: {
			store,
			author: publicationAuthor,
			assertSourceCurrent: (job) =>
				assertWorkSourceCurrent(
					options.workSource,
					store.workEvidence(job.worldId),
				),
		},
		config: (worldId) => store.lifeConfig(worldId),
		acquireLease: (...args) => store.acquireLifeLease(...args),
		identity(worldId, version) {
			const { identity, profiles } = fleetLifeIdentity(
				store,
				agents,
				worldId,
				options.personalGrowth,
				version,
			);
			return {
				identity,
				profiles,
				modelSettingsRevision: modelSettings.snapshot().revision,
			};
		},
		// Private status/detail remains the diagnostic surface; no source text goes to logs or chat.
		onError: (worldId) => {
			failures.set(worldId, "scheduler_unavailable");
		},
	});
	return {
		...runtime,
		assertWorkCurrent: (worldId: string) =>
			assertWorkSourceCurrent(options.workSource, store.workEvidence(worldId)),
		start() {
			bridge?.start();
			runtime.start();
		},
		async close() {
			bridge?.close();
			// Abort image I/O before the scheduler awaits its active visit.
			await options.images?.close();
			await runtime.close();
		},
		status: (worldId: string) => ({
			...runtime.status(worldId),
			schedulerError:
				failures.get(worldId) ?? failures.get("scheduler") ?? null,
		}),
		step: (worldId: string, stepId: string) => store.lifeStep(worldId, stepId),
		changed(worldId?: string) {
			if (worldId) {
				failures.delete(worldId);
				runtime.configChanged(worldId);
			} else {
				for (const id of worldIds()) runtime.identityChanged(id);
			}
		},
	};
}
export type FleetLifeRuntime = ReturnType<typeof createFleetLifeRuntime>;
