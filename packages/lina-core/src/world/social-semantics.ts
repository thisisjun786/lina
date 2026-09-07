import { lifeDigest } from "./life-json.ts";
import { assertSocialCapacity } from "./social-capacity.ts";
import { socialDataKey } from "./social-codec.ts";
import type {
	CompiledSocialPack,
	CompiledSocialPredicate,
	SocialBinding,
	SocialCondition,
	SocialPredicateEffect,
	SocialReference,
} from "./social-types.ts";

type Semantics = Pick<
	CompiledSocialPack,
	"worldId" | "cast" | "life" | "predicates" | "variables" | "definition"
>;
export function assertSocialValue(
	predicate: Pick<CompiledSocialPredicate, "type" | "min" | "max">,
	value: number | boolean,
): void {
	if (
		typeof value !== predicate.type ||
		(typeof value === "number" &&
			(!Number.isFinite(value) ||
				Math.abs(value) > Number.MAX_SAFE_INTEGER ||
				(predicate.min !== null && value < predicate.min) ||
				(predicate.max !== null && value > predicate.max)))
	)
		throw Error("Invalid social predicate value or bounds");
}
export function assertCompiledSocialSemantics(pack: Semantics): void {
	assertSocialCapacity(pack);
	const { cast, predicates, definition } = pack;
	const agents = new Set(cast.map((c) => c.agentId));
	for (const agent of agents) socialDataKey(agent);
	for (const action of definition.actions) socialDataKey(action.id);
	const roles = new Set(cast.map((c) => c.roleId));
	const named = new Map(predicates.map((p) => [p.id, p]));
	const actions = new Map(definition.actions.map((a) => [a.id, a]));
	const known = (ids: string[]) => {
		if (ids.some((id) => !agents.has(id))) throw Error("Unknown social agent");
	};
	if (
		pack.life.worldId !== pack.worldId ||
		lifeDigest([...agents].sort()) !==
			lifeDigest([...pack.life.participants].sort())
	)
		throw Error("Social LIFE cast mismatch");
	if (
		predicates.length !== definition.policies.length ||
		named.size !== predicates.length
	)
		throw Error("Social predicate policy mismatch");
	const mappedAxes = new Set<string>();
	for (const predicate of predicates) {
		if (
			predicate.type !== "number" &&
			(predicate.min !== null || predicate.max !== null)
		)
			throw Error("Invalid social boolean bounds");
		if (
			predicate.min !== null &&
			predicate.max !== null &&
			predicate.min > predicate.max
		)
			throw Error("Invalid social bounds");
		assertSocialValue(predicate, predicate.initial);
		const policy = definition.policies.find(
			(p) => p.predicateId === predicate.id,
		);
		if (!policy || lifeDigest(policy) !== lifeDigest(predicate.policy))
			throw Error("Social predicate policy mismatch");
		if (policy.visibility.kind === "agents") known(policy.visibility.agentIds);
		if (
			policy.resource &&
			(predicate.type !== "number" ||
				predicate.direction !== "undirected" ||
				predicate.min === null ||
				predicate.min < 0 ||
				policy.duration !== null ||
				policy.attitudeAxisId !== null)
		)
			throw Error("Invalid social resource mapping");
		if (policy.attitudeAxisId !== null) {
			const axis = pack.life.attitudes.find(
				(a) => a.id === policy.attitudeAxisId,
			);
			if (
				!axis ||
				mappedAxes.has(axis.id) ||
				predicate.type !== "number" ||
				predicate.direction !== "directed" ||
				axis.min !== predicate.min ||
				axis.max !== predicate.max ||
				axis.initial !== predicate.initial
			)
				throw Error("Invalid social attitude mapping");
			mappedAxes.add(axis.id);
		}
	}
	for (const variable of pack.variables) {
		known(variable.knownTo);
		if (typeof variable.initial !== variable.type)
			throw Error("Invalid social variable type");
		if (typeof variable.initial === "number")
			assertSocialValue({ ...variable, type: "number" }, variable.initial);
		else if (variable.min !== null || variable.max !== null)
			throw Error("Invalid social variable bounds");
	}
	function bindings(items: SocialBinding[]): Set<string> {
		for (const item of items) {
			if (item.roleId !== null && !roles.has(item.roleId))
				throw Error("Unknown social role");
			if (item.agentId !== null) {
				known([item.agentId]);
				if (
					item.roleId !== null &&
					!cast.some(
						(c) => c.agentId === item.agentId && c.roleId === item.roleId,
					)
				)
					throw Error("Social concrete agent role mismatch");
			}
		}
		return new Set(items.map((b) => b.id));
	}
	function reference(
		ref: SocialReference,
		scope: Set<string>,
		contextual: boolean,
	): void {
		if (ref.kind === "agent") known([ref.agentId]);
		else if (ref.kind === "binding") {
			if (!scope.has(ref.id)) throw Error("Undeclared social binding");
		} else if (!contextual)
			throw Error("Social rule requires explicit bindings");
	}
	function pair(
		item: {
			predicateId: string;
			first: SocialReference;
			second: SocialReference | null;
		},
		scope: Set<string>,
		contextual: boolean,
	): CompiledSocialPredicate {
		const predicate = named.get(item.predicateId);
		if (!predicate) throw Error("Unknown social predicate");
		if ((predicate.direction === "undirected") !== (item.second === null))
			throw Error("Social predicate direction mismatch");
		if (
			item.second !== null &&
			lifeDigest(item.first) === lifeDigest(item.second)
		)
			throw Error("Social directed participants must differ");
		reference(item.first, scope, contextual);
		if (item.second) reference(item.second, scope, contextual);
		return predicate;
	}
	function condition(
		item: SocialCondition,
		scope: Set<string>,
		contextual: boolean,
	): void {
		const predicate = pair(item, scope, contextual);
		assertSocialValue(predicate, item.value);
		if (predicate.type === "boolean" && item.operator !== "=")
			throw Error("Invalid social boolean comparison");
	}
	function effect(
		item: SocialPredicateEffect,
		scope: Set<string>,
		contextual: boolean,
	): void {
		const predicate = pair(item, scope, contextual);
		if (predicate.policy.resource)
			throw Error("Social resource writes require paired transfer");
		if (item.operator === "=") assertSocialValue(predicate, item.value);
		else if (
			predicate.type !== "number" ||
			typeof item.value !== "number" ||
			item.value < 0 ||
			(predicate.min !== null &&
				predicate.max !== null &&
				item.value > predicate.max - predicate.min)
		)
			throw Error("Invalid social numeric delta");
	}
	for (const rule of definition.triggers) {
		const scope = bindings(rule.bindings);
		for (const c of rule.conditions) condition(c, scope, false);
		for (const e of rule.effects) effect(e, scope, false);
	}
	for (const rule of definition.volitions) {
		const scope = bindings(rule.bindings);
		for (const c of rule.conditions) condition(c, scope, false);
		for (const e of rule.effects) pair(e, scope, false);
	}
	for (const action of definition.actions) {
		const scope = bindings(action.bindings);
		for (const c of action.conditions) condition(c, scope, true);
		for (const influence of action.influence)
			for (const c of influence.conditions) condition(c, scope, true);
		if (action.kind === "terminal")
			for (const e of action.effects) effect(e, scope, true);
		else {
			if (action.kind === "root" && !named.has(action.intent.predicateId))
				throw Error("Unknown social intent predicate");
			for (const child of action.children)
				if (!actions.has(child) || actions.get(child)?.kind === "root")
					throw Error("Invalid social action child");
		}
	}
	// Iterative DFS bounds both cycles and nested action expansion without recursion.
	for (const action of definition.actions) {
		const stack = [{ id: action.id, path: new Set<string>() }];
		let operations = 0;
		while (stack.length) {
			const current = stack.pop();
			if (!current) break;
			if (
				++operations > 65_536 ||
				current.path.size >= 24 ||
				current.path.has(current.id)
			)
				throw Error("Social action cycle or depth capacity");
			const node = actions.get(current.id);
			if (!node || node.kind === "terminal") continue;
			for (const id of node.children)
				stack.push({ id, path: new Set([...current.path, current.id]) });
		}
	}
	for (const capability of definition.capabilities) {
		known(capability.knownTo);
		if (
			[...capability.actorRoleIds, ...capability.targetRoleIds].some(
				(r) => !roles.has(r),
			)
		)
			throw Error("Unknown social capability role");
		if (!capability.actorRoleIds.length || !capability.primitives.length)
			throw Error("Empty social capability");
		if (
			capability.rootActionId !== null &&
			actions.get(capability.rootActionId)?.kind !== "root"
		)
			throw Error("Unknown social capability root");
		if (
			capability.primitives.includes("attempt") !==
			(capability.rootActionId !== null)
		)
			throw Error("Social capability root mismatch");
		for (const c of capability.conditions) condition(c, new Set(), true);
	}
}
