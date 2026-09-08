import type { BehaviorJobInput } from "../../../lina-core/src/agents/behavior-types.ts";
import { behaviorDigest } from "../../../lina-core/src/agents/behavior-validation.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { LifeDefinition } from "../../../lina-core/src/world/life-types.ts";
import { contentHash } from "../../../lina-memory/src/engine/reasoning.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import {
	growthRecords,
	growthSourcesCurrent,
	type PersonalGrowthSource,
} from "./growth-source.ts";

export interface NativeGrowthOptions {
	agents: AgentStore;
	agentId: string;
	source: PersonalGrowthSource;
	definition(): LifeDefinition | null;
	policy(): EnginePolicySnapshot;
	modelRevision(): number;
	interpret: NonNullable<ContextServices["interpretPersona"]>;
}

/** Runs inside the existing Companion lifecycle; no independent timer or provider owner. */
export class NativePersonaGrowth {
	private coverage = { selectedRecords: 0, omittedRecords: 0, inputChars: 0 };
	detail() {
		return { ...this.coverage };
	}
	constructor(private readonly options: NativeGrowthOptions) {}
	async run(signal: AbortSignal): Promise<void> {
		const o = this.options,
			profile = o.agents.get(o.agentId),
			definition = o.definition(),
			policy = o.policy();
		if (
			!definition ||
			!profile ||
			profile.evolution !== "adaptive" ||
			!policy.memory.enabled
		)
			return;
		const candidates = growthRecords(o.source);
		const records: typeof candidates = [];
		this.coverage = {
			selectedRecords: 0,
			omittedRecords: candidates.length,
			inputChars: 0,
		};
		if (!candidates.length) return;
		const selectors = {
			traits: definition.traits
				.filter((axis) =>
					definition.projection.sharedTraitIds.includes(axis.id),
				)
				.map((axis) => ({ axisId: axis.id, min: axis.min, max: axis.max })),
			habits: definition.habits
				.filter((axis) =>
					definition.projection.sharedHabitIds.includes(axis.id),
				)
				.map((axis) => ({ habitId: axis.id })),
		};
		if (!selectors.traits.length && !selectors.habits.length) return;
		const render = () =>
			JSON.stringify({
				profile: {
					name: profile.name,
					role: profile.role,
					voice: profile.voice,
					personality: profile.personality,
				},
				dimensions: {
					traits: definition.traits.filter((axis) =>
						selectors.traits.some((s) => s.axisId === axis.id),
					),
					habits: definition.habits.filter((axis) =>
						selectors.habits.some((s) => s.habitId === axis.id),
					),
				},
				records: records.map((row) => ({
					id: row.id,
					kind: row.kind,
					text: row.text,
					support: row.support,
				})),
			});
		for (const row of candidates.slice(
			0,
			Math.min(policy.memory.maxVisits, 32),
		)) {
			records.push(row);
			if (render().length > policy.memory.inputChars) records.pop();
		}
		records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const prompt = render();
		this.coverage = {
			selectedRecords: records.length,
			omittedRecords: candidates.length - records.length,
			inputChars: prompt.length,
		};
		if (prompt.length > policy.memory.inputChars)
			throw Error("Personal interpretation input budget exceeded");
		if (!records.length) return;
		const input: BehaviorJobInput = {
			version: 1,
			agentId: o.agentId,
			worldId: definition.worldId,
			profileRevision: profile.revision,
			definitionRevision: definition.revision,
			projectionRevision: definition.projection.revision,
			policyRevision: policy.revision,
			modelSettingsRevision: o.modelRevision(),
			definitionDigest: behaviorDigest(definition),
			projectionDigest: behaviorDigest(definition.projection),
			promptDigest: behaviorDigest(prompt),
			maxAttempts: policy.memory.maxAttempts,
			records: records.map((row) => ({
				recordId: row.id,
				revision: row.revision,
				contentHash: contentHash(row),
				proofDigest: behaviorDigest(row.sourceProofs),
				proofs: row.sourceProofs ?? [],
			})),
			selectors,
		};
		const store = o.agents.behavior,
			job = store.enqueue(input);
		if (job.state === "committed") return;
		const current = (frozen: BehaviorJobInput) => {
			const p = o.agents.get(o.agentId),
				def = o.definition();
			return (
				!!p &&
				!!def &&
				o.policy().revision === frozen.policyRevision &&
				o.policy().memory.enabled &&
				o.modelRevision() === frozen.modelSettingsRevision &&
				growthSourcesCurrent(o.source, frozen, p, def)
			);
		};
		if (
			job.state === "withheld" &&
			store.reactivate(job.id, current).state === "withheld"
		)
			return;
		const guard = () => {
			signal.throwIfAborted();
			if (behaviorDigest(prompt) !== job.input.promptDigest)
				throw Error("Personal interpretation prompt differs from frozen input");
			if (!current(job.input))
				throw Error("Personal interpretation source changed");
		};
		guard();
		const claim = store.claim(
			job.id,
			store.revision(o.agentId, definition.worldId),
		);
		if (!claim) return;
		let received = false;
		try {
			const result = await o.interpret(
				prompt,
				signal,
				guard,
				undefined,
				policy.memory.maxOutputTokens,
			);
			received = true;
			guard();
			store.commit(claim, JSON.parse(result), current);
		} catch (error) {
			store.fail(
				claim,
				signal.aborted
					? "cancelled"
					: !current(job.input)
						? "source_withheld"
						: received
							? "invalid_output"
							: "provider_failed",
			);
			throw error;
		}
	}
}
