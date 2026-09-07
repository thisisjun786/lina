import { lifeDigest } from "./life-json.ts";
import type { LifeState } from "./life-types.ts";
import { assertSocialCapacity } from "./social-capacity.ts";
import { decodeSocialValue } from "./social-codec.ts";
import type {
	CompiledSocialPack,
	CompiledSocialPredicate,
	SocialActorView,
	SocialCondition,
	SocialReference,
} from "./social-types.ts";
import type { WorldSnapshot } from "./types.ts";

export function assertSocialSource(
	pack: CompiledSocialPack,
	world: WorldSnapshot,
	life: LifeState,
): void {
	assertSocialCapacity(pack);
	if (
		pack.worldId !== world.definition.id ||
		life.worldId !== pack.worldId ||
		pack.packVersion !== world.definition.version ||
		life.worldRevision !== world.revision ||
		life.definitionRevision !== pack.life.revision ||
		lifeDigest([...world.definition.agents].sort()) !==
			lifeDigest(pack.cast.map((c) => c.agentId).sort())
	)
		throw Error("Social source boundary mismatch");
}

export function socialReferenceAgent(
	ref: SocialReference,
	actor: string,
	target: string | null,
	bindings: Record<string, string> = {},
): string | null {
	if (ref.kind === "actor") return actor;
	if (ref.kind === "target") return target;
	if (ref.kind === "agent") return ref.agentId;
	return bindings[ref.id] ?? null;
}

export function socialValueVisible(
	predicate: CompiledSocialPredicate,
	first: string,
	agent: string,
): boolean {
	const visibility = predicate.policy.visibility;
	return (
		visibility.kind === "public" ||
		(visibility.kind === "first"
			? first === agent
			: visibility.agentIds.includes(agent))
	);
}

export function currentSocialValue(
	_pack: CompiledSocialPack,
	life: LifeState,
	predicate: CompiledSocialPredicate,
	first: string,
	second: string | null,
	atStep?: number,
): number | boolean | null {
	const checkpoint = life.checkpoint;
	if (checkpoint.engineId === "ensemble") {
		const step = atStep ?? checkpoint.data.state.step;
		const introductions = [
			...checkpoint.data.predicateIntroductions.filter(
				(i) => i.id === predicate.id,
			),
			...checkpoint.data.agentIntroductions.filter(
				(i) => i.id === first || i.id === second,
			),
		];
		if (introductions.some((i) => step < i.socialStep)) return null;
		const history = decodeSocialValue(checkpoint.data.state.history);
		if (!Array.isArray(history) || !Array.isArray(history[step]))
			throw Error("Invalid social history slice");
		const record = history[step].find(
			(row: Record<string, unknown>) =>
				row["category"] === socialPredicateCategory(predicate.id) &&
				row["type"] === "value" &&
				row["first"] === first &&
				(row["second"] ?? null) === second &&
				row["isActive"] !== false,
		);
		if (record) return record.value;
		return predicate.initial;
	}
	if (atStep !== undefined && atStep !== 0) return null;
	if (predicate.policy.attitudeAxisId !== null)
		return (
			life.attitudes.find(
				(a) =>
					a.axisId === predicate.policy.attitudeAxisId &&
					a.fromAgentId === first &&
					a.toAgentId === second,
			)?.value ?? predicate.initial
		);
	return predicate.initial;
}

/** Stable IDs, never labels or prototype-sensitive author strings, name engine categories. */
export function socialPredicateCategory(predicateId: string): string {
	return `p_${Buffer.from(predicateId, "utf8").toString("hex")}`;
}

function actorCondition(
	pack: CompiledSocialPack,
	life: LifeState,
	actor: string,
	target: string | null,
	condition: SocialCondition,
): boolean {
	const predicate = pack.predicates.find((p) => p.id === condition.predicateId);
	const first = socialReferenceAgent(condition.first, actor, target);
	const second = condition.second
		? socialReferenceAgent(condition.second, actor, target)
		: null;
	if (
		!predicate ||
		first === null ||
		(condition.second !== null && second === null)
	)
		return false;
	// Unknown/private prerequisites stay pending. Their truth must not shape the menu.
	if (!socialValueVisible(predicate, first, actor)) return true;
	const step =
		life.checkpoint.engineId === "ensemble"
			? life.checkpoint.data.state.step
			: 0;
	const recent = condition.window?.mostRecent ?? 0,
		old = condition.window?.leastRecent ?? 0;
	for (let time = Math.max(0, step - old); time <= step - recent; time++) {
		const value = currentSocialValue(
			pack,
			life,
			predicate,
			first,
			second,
			time,
		);
		if (
			value !== null &&
			(condition.operator === "="
				? value === condition.value
				: typeof value === "number" &&
					typeof condition.value === "number" &&
					(condition.operator === ">"
						? value > condition.value
						: value < condition.value))
		)
			return true;
	}
	return false;
}

export function projectSocialActorView(
	pack: CompiledSocialPack,
	world: WorldSnapshot,
	life: LifeState,
	agentId: string,
	targetAgentId: string | null,
): SocialActorView {
	assertSocialSource(pack, world, life);
	const actor = pack.cast.find((c) => c.agentId === agentId && c.active);
	const target = pack.cast.find((c) => c.agentId === targetAgentId && c.active);
	if (
		!actor ||
		(targetAgentId !== null && (!target || agentId === targetAgentId))
	)
		throw Error("Invalid social view actor or target");
	const values: SocialActorView["values"] = [];
	for (const predicate of pack.predicates)
		for (const first of pack.cast) {
			if (!socialValueVisible(predicate, first.agentId, agentId)) continue;
			const seconds =
				predicate.direction === "undirected"
					? [null]
					: pack.cast
							.filter((c) => c.agentId !== first.agentId)
							.map((c) => c.agentId);
			for (const second of seconds) {
				if (values.length >= 4096) throw Error("Social view capacity exceeded");
				const value = currentSocialValue(
					pack,
					life,
					predicate,
					first.agentId,
					second,
				);
				if (value !== null)
					values.push({
						predicateId: predicate.id,
						firstAgentId: first.agentId,
						secondAgentId: second,
						value,
					});
			}
		}
	const capabilities = pack.definition.capabilities
		.filter(
			(c) =>
				c.knownTo.includes(agentId) &&
				c.actorRoleIds.includes(actor.roleId) &&
				(!c.targetRoleIds.length ||
					(target && c.targetRoleIds.includes(target.roleId))) &&
				c.conditions.every((condition) =>
					actorCondition(pack, life, agentId, targetAgentId, condition),
				),
		)
		.map((c) => ({
			id: c.id,
			description: c.description,
			primitives: [...c.primitives],
			rootActionId: c.rootActionId,
		}));
	return { agentId, values, capabilities };
}
