import type { SocialEffectState } from "./social-effect-state.ts";
import type {
	SocialAction,
	SocialBinding,
	SocialCondition,
	SocialPredicateEffect,
	SocialReference,
	SocialResolveInput,
	SocialTriggerRule,
} from "./social-types.ts";

export type SocialBoundAgents = Record<string, string>;
export function socialReferenceKey(
	ref: SocialReference,
	scope: string,
): string {
	if (ref.kind === "actor") return "initiator";
	if (ref.kind === "target") return "responder";
	if (ref.kind === "agent")
		return `c_${Buffer.from(ref.agentId).toString("hex")}`;
	return `b_${Buffer.from(scope).toString("hex")}_${Buffer.from(ref.id).toString("hex")}`;
}
export function boundSocialNode<
	T extends SocialCondition | SocialPredicateEffect,
>(
	node: T,
	scope: string,
	bindings: SocialBoundAgents,
): Omit<T, "first" | "second"> & { first: string; second: string | null } {
	const first = bindings[socialReferenceKey(node.first, scope)],
		second =
			node.second === null
				? null
				: bindings[socialReferenceKey(node.second, scope)];
	if (first === undefined || second === undefined)
		throw Error("Missing declared social binding");
	return { ...node, first, second };
}

type Slot = { key: string; roleId: string | null; agentId: string | null };
function slots(owner: SocialAction | SocialTriggerRule, scope: string): Slot[] {
	const result = new Map<string, Slot>();
	const add = (ref: SocialReference) => {
		const key = socialReferenceKey(ref, scope),
			declared =
				ref.kind === "binding"
					? owner.bindings.find((b) => b.id === ref.id)
					: undefined;
		if (!result.has(key))
			result.set(key, {
				key,
				roleId: declared?.roleId ?? null,
				agentId:
					ref.kind === "agent" ? ref.agentId : (declared?.agentId ?? null),
			});
	};
	const declare = (binding: SocialBinding) =>
		add({ kind: "binding", id: binding.id });
	if ("kind" in owner) for (const binding of owner.bindings) declare(binding);
	for (const node of [
		...owner.conditions,
		...("effects" in owner ? owner.effects : []),
		...("influence" in owner
			? owner.influence.flatMap((i) => i.conditions)
			: []),
	]) {
		add(node.first);
		if (node.second) add(node.second);
	}
	if (!("kind" in owner))
		for (const binding of owner.bindings) declare(binding);
	return "kind" in owner
		? [...result.values()].sort((a, b) =>
				a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
			)
		: [...result.values()];
}

/** Rule slots follow predicate first-appearance order; action slots use their canonical engine keys. */
export function enumerateSocialBindings(
	input: SocialResolveInput,
	state: SocialEffectState,
	owner: SocialAction | SocialTriggerRule,
	scope: string,
	prior: SocialBoundAgents,
	visit: (bindings: SocialBoundAgents) => boolean,
): boolean {
	const previous =
		input.checkpoint.engineId === "ensemble"
			? input.checkpoint.data.state
			: null;
	const cast = input.rulePack.cast.filter(
		(c) =>
			c.active &&
			!previous?.offstage.includes(c.agentId) &&
			!previous?.eliminated.includes(c.agentId),
	);
	const assigned = { ...prior },
		free: Slot[] = [];
	const allowed = (slot: Slot, agent: string) =>
		input.rulePack.cast.some(
			(c) =>
				c.agentId === agent &&
				c.active &&
				(slot.roleId === null || c.roleId === slot.roleId) &&
				(slot.agentId === null || c.agentId === slot.agentId),
		);
	for (const slot of slots(owner, scope)) {
		const fixed = assigned[slot.key] ?? slot.agentId;
		if (fixed !== null && fixed !== undefined) {
			if (!allowed(slot, fixed)) return false;
			assigned[slot.key] = fixed;
		} else free.push(slot);
	}
	// Pinned actions reset their candidate cast at each recursive fill: new slots may
	// reuse a participant, but inherited bindings remain excluded. Rules are distinct.
	const action = "kind" in owner,
		used = new Set(action ? Object.values(prior) : []);
	function fill(index: number): boolean {
		state.bindingTick();
		const slot = free[index];
		if (!slot) return visit({ ...assigned }) === true;
		for (const member of cast) {
			if (used.has(member.agentId) || !allowed(slot, member.agentId)) continue;
			assigned[slot.key] = member.agentId;
			if (!action) used.add(member.agentId);
			if (fill(index + 1)) return true;
			if (!action) used.delete(member.agentId);
			delete assigned[slot.key];
		}
		return false;
	}
	return fill(0);
}
