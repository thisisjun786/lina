import {
	currentDisclosurePolicy,
	knowsClaimAt,
} from "../../../../lina-core/src/world/life-knowledge.ts";
import { socialRecord } from "../../../../lina-core/src/world/social-checkpoint-validation.ts";
import type {
	SocialEffect,
	SocialResolveInput,
} from "../../../../lina-core/src/world/social-types.ts";
import { socialPredicateCategory as predicateCategory } from "../../../../lina-core/src/world/social-views.ts";
import type { EnginePredicate, PinnedEnsemble } from "./pinned-types.ts";

type Value = Extract<SocialEffect, { kind: "predicate" }>;
export const valueKey = (id: string, first: string, second: string | null) =>
	JSON.stringify([id, first, second]);
export function readValues(
	input: SocialResolveInput,
	engine: PinnedEnsemble,
): Map<string, Value> {
	const raw = engine.readState();
	if (!Array.isArray(raw.history) || !Array.isArray(raw.history[raw.step]))
		throw Error("Invalid engine history");
	// The raw ABI has been parsed on restore; these named fields keep strict index access local.
	const records = (raw.history[raw.step] as unknown[]).map((value) => {
		const {
			category,
			type,
			first,
			second,
			value: current,
		} = socialRecord(value);
		return { category, type, first, second, value: current };
	});
	const values = new Map<string, Value>();
	const cast = input.rulePack.cast.map((c) => c.agentId);
	for (const p of input.rulePack.predicates)
		for (const first of cast)
			for (const second of p.direction === "undirected"
				? [null]
				: cast.filter((id) => id !== first)) {
				const record = records.find(
					(f) =>
						f.category === predicateCategory(p.id) &&
						f.type === "value" &&
						f.first === first &&
						(f.second ?? null) === second,
				);
				const value = record?.value ?? p.initial;
				if (typeof value !== "boolean" && typeof value !== "number")
					throw Error("Invalid engine predicate value");
				values.set(valueKey(p.id, first, second), {
					kind: "predicate",
					predicateId: p.id,
					firstAgentId: first,
					secondAgentId: second,
					previous: value,
					next: value,
				});
			}
	return values;
}

export function primitiveChanges(
	input: SocialResolveInput,
	values: Map<string, Value>,
) {
	const balances = new Map([...values].map(([key, v]) => [key, v.next]));
	const transfers: EnginePredicate[] = [];
	const effects: SocialEffect[] = [];
	for (const p of input.intent.primitives) {
		if (p.kind === "attempt") continue;
		if (p.kind === "move") {
			if (!input.world.scenes.some((s) => s.id === p.sceneId))
				throw Error("Unknown social move scene");
			effects.push({
				kind: "move",
				agentId: input.intent.agentId,
				sceneId: p.sceneId,
			});
		} else if (p.kind === "goal")
			effects.push({
				kind: "goal",
				agentId: input.intent.agentId,
				goalId: p.goalId,
				description: p.description,
			});
		else if (p.kind === "reveal") {
			const policy = currentDisclosurePolicy(p.claim, input.rulePack.life);
			if (
				!knowsClaimAt(p.claim, input.intent.agentId, input.world, input.life) ||
				!policy?.knowers.includes(input.intent.agentId) ||
				!policy.disclosures.some(
					(d) =>
						d.agentId === input.intent.agentId && d.recipientId === p.toAgentId,
				)
			)
				return null;
			effects.push({
				kind: "reveal",
				fromAgentId: input.intent.agentId,
				toAgentId: p.toAgentId,
				claim: p.claim,
			});
		} else {
			const definition = input.rulePack.predicates.find(
				(d) => d.id === p.predicateId,
			);
			if (
				!definition?.policy.resource ||
				!Number.isFinite(p.amount) ||
				p.amount <= 0
			)
				throw Error("Invalid social transfer");
			const fromKey = valueKey(p.predicateId, input.intent.agentId, null),
				toKey = valueKey(p.predicateId, p.toAgentId, null);
			const from = balances.get(fromKey),
				to = balances.get(toKey);
			if (typeof from !== "number" || typeof to !== "number")
				throw Error("Missing resource balance");
			const left = from - p.amount,
				right = to + p.amount;
			if (
				!Number.isFinite(left) ||
				!Number.isFinite(right) ||
				left < (definition.min ?? 0) ||
				(definition.max !== null && right > definition.max)
			)
				return null;
			balances.set(fromKey, left);
			balances.set(toKey, right);
			transfers.push(
				{
					category: predicateCategory(p.predicateId),
					type: "value",
					first: input.intent.agentId,
					value: left,
					origin: "lina-transfer",
				},
				{
					category: predicateCategory(p.predicateId),
					type: "value",
					first: p.toAgentId,
					value: right,
					origin: "lina-transfer",
				},
			);
		}
	}
	return { transfers, effects };
}

export function assertEngineWrite(
	input: SocialResolveInput,
	predicate: EnginePredicate,
	engine: PinnedEnsemble,
	resourcesAllowed: boolean,
): void {
	const def = input.rulePack.predicates.find(
		(p) => predicateCategory(p.id) === predicate.category,
	);
	if (!def || predicate.type !== "value")
		throw Error("Unknown engine predicate");
	if (def.policy.resource && !resourcesAllowed)
		throw Error("Mapped resource requires paired transfer");
	if (def.policy.attitudeAxisId) {
		const profile = input.identity.profiles.find(
			(p) => p.agentId === predicate.first,
		);
		if (!profile) throw Error("Missing social identity policy");
		const current = readValues(input, engine).get(
			valueKey(def.id, predicate.first, predicate.second ?? null),
		)?.next;
		const changes =
			predicate.operator === "+" || predicate.operator === "-"
				? predicate.value !== 0
				: predicate.value !== current;
		if (
			changes &&
			(profile.evolution !== "adaptive" ||
				profile.lockedAttitudeIds.includes(def.policy.attitudeAxisId))
		)
			throw Error("Social identity axis locked");
	}
}
