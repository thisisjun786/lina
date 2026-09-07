import type {
	CompiledSocialPack,
	SocialBinding,
	SocialCondition,
	SocialPredicateEffect,
	SocialReference,
} from "../../../../lina-core/src/world/social-types.ts";
import { socialPredicateCategory as predicateCategory } from "../../../../lina-core/src/world/social-views.ts";
import type { EnginePredicate, PinnedEnsemble } from "./pinned-types.ts";

const roleKey = (scope: string, id: string) =>
	`b_${Buffer.from(scope).toString("hex")}_${Buffer.from(id).toString("hex")}`;
type BindingConstraint = { roleId: string | null; agentId: string | null };

/** Converts only the typed compiler product, in the child engine's native realm. */
export function engineTables(pack: CompiledSocialPack) {
	const constraints = new Map<string, BindingConstraint>();
	function reference(ref: SocialReference, scope: string): string {
		if (ref.kind === "actor") return "initiator";
		if (ref.kind === "target") return "responder";
		if (ref.kind === "binding") return roleKey(scope, ref.id);
		const key = `c_${Buffer.from(ref.agentId).toString("hex")}`;
		constraints.set(key, { roleId: null, agentId: ref.agentId });
		return key;
	}
	function predicate(
		item: SocialCondition | SocialPredicateEffect,
		scope: string,
	): EnginePredicate {
		return {
			category: predicateCategory(item.predicateId),
			type: "value",
			first: reference(item.first, scope),
			...(item.second ? { second: reference(item.second, scope) } : {}),
			operator: item.operator,
			value: item.value,
			...("window" in item && item.window
				? {
						turnsAgoBetween: [
							item.window.mostRecent,
							item.window.leastRecent,
						] as [number, number],
					}
				: {}),
		};
	}
	function bindings(items: SocialBinding[], scope: string): string[] {
		return items.map((item) => {
			const key = roleKey(scope, item.id);
			constraints.set(key, { roleId: item.roleId, agentId: item.agentId });
			return key;
		});
	}
	const schema = pack.predicates.map((p) => ({
		category: predicateCategory(p.id),
		types: ["value"],
		isBoolean: p.type === "boolean",
		directionType: p.direction,
		defaultValue: p.initial,
		actionable: true,
		...(p.type === "number"
			? {
					minValue: p.min ?? -Number.MAX_SAFE_INTEGER,
					maxValue: p.max ?? Number.MAX_SAFE_INTEGER,
				}
			: {}),
		...(p.policy.duration === null ? {} : { duration: p.policy.duration }),
	}));
	const triggers = pack.definition.triggers.map((rule) => ({
		name: rule.id,
		linaRoles: bindings(rule.bindings, `t:${rule.id}`),
		conditions: rule.conditions.map((c) => predicate(c, `t:${rule.id}`)),
		effects: rule.effects.map((e) => predicate(e, `t:${rule.id}`)),
	}));
	const volitions = pack.definition.volitions.map((rule) => ({
		name: rule.id,
		linaRoles: bindings(rule.bindings, `v:${rule.id}`),
		conditions: rule.conditions.map((c) => predicate(c, `v:${rule.id}`)),
		effects: rule.effects.map((e) => ({
			category: predicateCategory(e.predicateId),
			type: "value",
			first: reference(e.first, `v:${rule.id}`),
			...(e.second ? { second: reference(e.second, `v:${rule.id}`) } : {}),
			intentType: e.intentType,
			weight: e.weight,
		})),
	}));
	const actions = pack.definition.actions.map((action) => {
		const scope = `a:${action.id}`;
		const conditions = action.conditions.map((c) => predicate(c, scope));
		const influenceRules = action.influence.map((i) => ({
			conditions: i.conditions.map((c) => predicate(c, scope)),
			weight: i.weight,
		}));
		const effects =
			action.kind === "terminal"
				? action.effects.map((e) => predicate(e, scope))
				: [];
		const roles = new Set(bindings(action.bindings, scope));
		for (const p of [
			...conditions,
			...effects,
			...influenceRules.flatMap((i) => i.conditions),
		]) {
			roles.add(p.first);
			if (p.second) roles.add(p.second);
		}
		const base = {
			name: action.id,
			conditions,
			influenceRules,
			linaRoles: [...roles].sort(),
		};
		if (action.kind === "terminal")
			return {
				...base,
				effects,
				...(action.acceptance === "either"
					? { linaEither: true }
					: { isAccept: action.acceptance === "accepted" }),
			};
		const children = { leadsTo: [...action.children].sort() };
		if (action.kind === "group") return { ...base, ...children };
		return {
			...base,
			...children,
			intent: {
				category: predicateCategory(action.intent.predicateId),
				type: "value",
				first: "initiator",
				second: "responder",
				intentType: action.intent.intentType,
			},
		};
	});
	function bindingAllowed(values: Record<string, string | number>): boolean {
		for (const [key, value] of Object.entries(values)) {
			if (value === "" || key === "weight$$") continue;
			const rule = constraints.get(key);
			if (!rule) continue;
			if (typeof value !== "string") return false;
			const member = pack.cast.find((c) => c.agentId === value && c.active);
			if (
				!member ||
				(rule.roleId !== null && rule.roleId !== member.roleId) ||
				(rule.agentId !== null && rule.agentId !== member.agentId)
			)
				return false;
		}
		return true;
	}
	return {
		bindingAllowed,
		fixedBinding: (key: string) => constraints.get(key)?.agentId ?? undefined,
		condition: (
			item: SocialCondition,
			actor: string,
			target: string | null,
		): EnginePredicate => {
			const p = predicate(item, "capability");
			const resolve = (key: string) =>
				key === "initiator"
					? actor
					: key === "responder"
						? (target ?? actor)
						: (constraints.get(key)?.agentId ?? key);
			return {
				...p,
				first: resolve(p.first),
				...(p.second ? { second: resolve(p.second) } : {}),
			};
		},
		load(engine: PinnedEnsemble) {
			engine.api.init();
			engine.api.loadSocialStructure({ schema });
			engine.api.addCharacters({
				cast: Object.fromEntries(pack.cast.map((c) => [c.agentId, {}])),
			});
			engine.api.addRules({
				fileName: "lina-trigger",
				type: "trigger",
				rules: triggers,
			});
			engine.api.addRules({
				fileName: "lina-volition",
				type: "volition",
				rules: volitions,
			});
			engine.api.addActions({ fileName: "lina-actions", actions });
		},
	};
}
