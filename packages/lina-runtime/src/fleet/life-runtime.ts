import { join } from "node:path";
import { createCodexLifeModel } from "../../../lina-codex/src/life-model.ts";
import type { CodexLifeModelOptions } from "../../../lina-codex/src/life-model-policy.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { IdentityPolicySnapshot } from "../../../lina-core/src/world/life-types.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
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

export interface FleetLifeContext {
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
	/** Trusted composition seam, inaccessible to HTTP and ordinary tools. */
	createModel?: typeof createCodexLifeModel;
}

export function fleetLifeIdentity(
	store: WorldStore,
	agents: AgentStore,
	worldId: string,
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
	return { identity, profiles };
}

/** One installation owns this runtime and its native transport; store ownership stays in fleet. */
export function createFleetLifeRuntime(options: FleetLifeOptions) {
	const { store, agents, modelSettings, foreground } = options;
	const clock = options.clock ?? systemLifeClock;
	const bridge = options.workSource
		? createWorkBridge({
				source: options.workSource,
				world: store,
				// Delivery attempts are durably visible in task management; never log task content.
				onError() {},
			})
		: undefined;
	const worldIds = () => {
		const ids: string[] = [];
		let afterId: string | null = null;
		do {
			const page = store.worldCatalog({ afterId, limit: 100 });
			for (const entry of page.items) {
				if (
					entry.packVersion !== null &&
					store.worldPack(entry.worldId).schemaVersion === 3 &&
					store.lifeConfig(entry.worldId).revision > 0
				)
					ids.push(entry.worldId);
			}
			afterId = page.nextCursor;
		} while (afterId !== null);
		return ids;
	};
	const model = (options.createModel ?? createCodexLifeModel)({
		stateRoot: join(options.stateRoot, "life", "model"),
		providerEnv: options.providerEnv,
		...(options.command ? { command: options.command } : {}),
		selection(request) {
			const step = store.lifeStep(request.worldId, request.stepId);
			const config = store.lifeConfig(request.worldId);
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
				lifeDigest(fleetLifeIdentity(store, agents, request.worldId)) !==
					lifeDigest({
						identity: step.source.identity,
						profiles: step.source.profiles,
					})
			)
				throw Error(
					"LIFE destination or source snapshot changed before model dispatch",
				);
			assertWorkSourceCurrent(options.workSource, step.source.work);
			const settings = modelSettings.snapshot();
			const route =
				config.models?.[request.lane === "director" ? "director" : "actor"];
			if (
				settings.revision !== request.modelSettingsRevision ||
				route?.provider !== request.provider ||
				route.model !== request.model
			)
				throw Error("LIFE exact model/settings selection changed");
			const matching = settings.profiles.filter(
				(profile) =>
					profile.provider === route.provider && profile.model === route.model,
			);
			// LIFE config selects a route, never the conversation default or another actor's profile.
			if (matching.length !== 1 || !matching[0])
				throw Error(
					"LIFE requires one explicit unambiguous model profile for its selected route",
				);
			return {
				connection: options.connection(),
				selected: matching[0],
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
		beforePrepare: () => {
			bridge?.poll();
		},
		assertSourceCurrent: (step) =>
			assertWorkSourceCurrent(options.workSource, step.source.work),
		config: (worldId) => store.lifeConfig(worldId),
		acquireLease: (...args) => store.acquireLifeLease(...args),
		identity(worldId) {
			const { identity, profiles } = fleetLifeIdentity(store, agents, worldId);
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
