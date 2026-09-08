import type { EvaluatedEffect } from "./authoring-types.ts";
import { autonomyEvaluationInput } from "./autonomy-source.ts";
import type { AutonomyState, LifeStep } from "./autonomy-types.ts";
import { finite, lifeDigest, MAX_LIFE_ITEMS } from "./life-json.ts";
import type { LifeCommitV3 } from "./life-types.ts";
import { evaluateLore, loreVisible } from "./lore.ts";
import {
	conditionPasses,
	createEvaluationContext,
	evaluateEffects,
	evaluateRules,
	visibleTo,
} from "./rules.ts";

function effectsFor(
	step: LifeStep,
	quiet: boolean,
): Array<{ sourceId: string; effects: EvaluatedEffect[] }> {
	const { pack } = step.source;
	const actor = step.decision.agentId;
	if (quiet) {
		const found: Array<{ sourceId: string; effects: EvaluatedEffect[] }> = [];
		for (const rule of [...pack.rules].sort(
			(a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1),
		)) {
			if (!rule.effects.length || rule.effects.some((x) => x.kind !== "assign"))
				continue;
			const agentId = pack.roles
				.filter(
					(x) => x.status === "active" && rule.knownTo.includes(x.agentId),
				)
				.map((x) => x.agentId)
				.sort()[0];
			if (!agentId) continue;
			const context = createEvaluationContext(
				pack,
				autonomyEvaluationInput(step.source, step.id, agentId),
			);
			if (
				conditionPasses(
					rule.condition,
					rule.probability,
					context,
					`rule:${rule.id}`,
				)
			)
				found.push({
					sourceId: `rule-${rule.id}`,
					effects: evaluateEffects(rule.effects, context, `rule:${rule.id}`),
				});
		}
		return found;
	}
	if (!actor) throw Error("Activity rule evaluation requires actor");
	const input = autonomyEvaluationInput(
			step.source,
			step.id,
			actor,
			step.intent?.targetAgentId ?? null,
		),
		context = createEvaluationContext(pack, input);
	const candidates = [
		...evaluateRules(
			pack.rules.filter((r) => visibleTo(r.knownTo, input)),
			context,
		),
		...evaluateLore(
			pack.lore.filter((l) => loreVisible(l, input)),
			context,
		).candidates,
	].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
	const found = candidates.map((c) => ({
		sourceId: `${c.kind}-${c.id}`,
		effects: c.effects,
	}));
	const family = pack.eventFamilies.find(
		(f) => f.id === step.decision.familyId,
	);
	if (family)
		found.push({
			sourceId: `family-${family.id}`,
			effects: evaluateEffects(family.effects, context, `family:${family.id}`),
		});
	return found;
}
/** Only evaluated authored effects reach here; generated prose never names an effect authority. */
export function applyAutonomyRules(
	step: LifeStep,
	state: AutonomyState,
	commit: LifeCommitV3,
	quiet: boolean,
): void {
	const limits = step.source.config.limits;
	if (!limits) throw Error("Autonomy rule limits unconfigured");
	const eventId = `${step.worldId}:${step.source.world.revision + 1}`;
	for (const source of effectsFor(step, quiet))
		for (const [index, effect] of source.effects.entries()) {
			const id = `rule-${lifeDigest([step.id, source.sourceId, index]).slice(0, 40)}`;
			if (effect.kind === "assign") {
				state.variables[effect.variableId] = effect.value;
				continue;
			}
			if (quiet) throw Error("Quiet rule cannot produce activity");
			const experience = (
				agentId: string,
				claims: LifeCommitV3["experiences"][number]["claims"] = [],
			) => {
				const evidenceId = `evidence-${lifeDigest([id, agentId]).slice(0, 40)}`;
				commit.experiences.push({
					id: evidenceId,
					agentId,
					eventId,
					channel: "inferred",
					claims,
					simulationTime: step.decision.simulationTime,
				});
				return evidenceId;
			};
			switch (effect.kind) {
				case "event": {
					if (state.pendingEvents.length >= MAX_LIFE_ITEMS)
						throw Error("Autonomy causal queue capacity exceeded");
					if (
						!step.source.pack.autonomy.events.some(
							(x) => x.familyId === effect.familyId,
						) ||
						!effect.actorIds.length ||
						effect.actorIds.some(
							(agentId) =>
								!step.source.pack.roles.some(
									(r) => r.agentId === agentId && r.status === "active",
								),
						)
					)
						throw Error("Unsupported autonomy causal event");
					const depth = (step.decision.parent?.depth ?? 0) + 1;
					state.pendingEvents.push({
						id,
						familyId: effect.familyId,
						actorIds: effect.actorIds,
						summary: effect.summary,
						parentStepId: step.id,
						rootStepId: step.decision.parent?.rootStepId ?? step.id,
						depth,
						status: depth > limits.maxCausalDepth ? "stopped" : "pending",
					});
					break;
				}
				case "fact": {
					const existing = [
						...step.source.world.facts,
						...commit.world.facts,
					].find((x) => x.id === effect.id);
					if (existing) {
						if (
							existing.text !== effect.text ||
							lifeDigest([...existing.knownTo].sort()) !==
								lifeDigest(effect.knownTo)
						)
							throw Error("Authored fact is immutable");
						break;
					}
					commit.world.facts.push({
						id: effect.id,
						text: effect.text,
						knownTo: effect.knownTo,
					});
					for (const agentId of effect.knownTo) {
						if (!commit.world.audience.includes(agentId))
							commit.world.audience.push(agentId);
						experience(agentId, [{ kind: "world_fact", id: effect.id }]);
					}
					break;
				}
				case "goal": {
					const prior = state.goals.find((x) => x.id === effect.id);
					if (
						prior &&
						(prior.agentId !== effect.agentId ||
							prior.description !== effect.description)
					)
						throw Error("Authored goal identity conflict");
					if (!prior)
						state.goals.push({
							id: effect.id,
							agentId: effect.agentId,
							description: effect.description,
							priority: 0,
							familyIds: step.decision.familyId ? [step.decision.familyId] : [],
							progress: 0,
							status: "active",
							createdAtStepId: step.id,
							lastStepId: step.id,
							experienceIds: [experience(effect.agentId)],
						});
					break;
				}
				case "attitude": {
					if (
						step.source.pack.social.policies.some(
							(p) => p.attitudeAxisId === effect.axisId,
						)
					)
						throw Error("Rule cannot write mapped social attitude");
					const policy = step.source.identity.profiles.find(
						(p) => p.agentId === effect.fromAgentId,
					);
					if (!policy) throw Error("Missing authored growth identity");
					if (
						policy.evolution === "manual" ||
						policy.lockedAttitudeIds.includes(effect.axisId)
					)
						break;
					const row = step.source.life.attitudes.find(
							(x) =>
								x.fromAgentId === effect.fromAgentId &&
								x.toAgentId === effect.toAgentId &&
								x.axisId === effect.axisId,
						),
						axis = step.source.pack.life.attitudes.find(
							(x) => x.id === effect.axisId,
						);
					if (!row || !axis) throw Error("Unknown authored attitude");
					const previous = commit.growth.find(
						(g) =>
							g.kind === "attitude" &&
							g.fromAgentId === effect.fromAgentId &&
							g.toAgentId === effect.toAgentId &&
							g.axisId === effect.axisId,
					);
					const next = finite(
						(previous?.kind === "attitude" ? previous.next : row.value) +
							effect.delta,
					);
					if (next < axis.min || next > axis.max)
						throw Error("Authored attitude bounds exceeded");
					const evidenceId = experience(effect.fromAgentId);
					if (previous?.kind === "attitude") {
						previous.next = next;
						previous.evidenceIds.push(evidenceId);
					} else if (next !== row.value)
						commit.growth.push({
							kind: "attitude",
							fromAgentId: effect.fromAgentId,
							toAgentId: effect.toAgentId,
							axisId: effect.axisId,
							previous: row.value,
							next,
							evidenceIds: [evidenceId],
						});
					break;
				}
			}
		}
	commit.world.audience.sort();
}
