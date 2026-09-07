import {
	assertVisible,
	checkAssignment,
	checkBoolean,
	checkExpression,
	checkNumber,
	checkVariableValue,
	type ExpressionScope,
} from "./authoring-expression-check.ts";
import type {
	AgentReference,
	RuleEffect,
	TextPart,
	WorldPack,
} from "./authoring-types.ts";
import { knownAgents } from "./validation.ts";

function checkText(parts: TextPart[], scope: ExpressionScope): void {
	for (const part of parts)
		if (part.kind === "value") checkExpression(part.expression, scope);
}
function activeAgents(pack: WorldPack): string[] {
	return pack.roles.filter((r) => r.status === "active").map((r) => r.agentId);
}
function referenceAudience(
	ref: AgentReference,
	pack: WorldPack,
	scope: ExpressionScope,
): string[] {
	if (ref.kind === "actor")
		return scope.audience.filter((id) => pack.world.agents.includes(id));
	if (ref.kind === "target") return activeAgents(pack);
	if (!activeAgents(pack).includes(ref.agentId))
		throw Error("Unknown or retired authoring agent reference");
	return [ref.agentId];
}
function checkEffects(
	effects: RuleEffect[],
	pack: WorldPack,
	scope: ExpressionScope,
): void {
	for (const effect of effects) {
		switch (effect.kind) {
			case "assign":
				checkAssignment(effect.variableId, effect.value, scope);
				break;
			case "event": {
				if (!pack.eventFamilies.some((f) => f.id === effect.familyId))
					throw Error("Unknown authoring event family");
				if (!effect.actorIds.length)
					throw Error("Authoring event requires actors");
				for (const ref of effect.actorIds)
					assertVisible(scope.audience, referenceAudience(ref, pack, scope));
				checkText(effect.summary, scope);
				break;
			}
			case "fact": {
				if (!effect.knownTo.length)
					throw Error("Authoring fact requires knowers");
				for (const ref of effect.knownTo)
					assertVisible(scope.audience, referenceAudience(ref, pack, scope));
				checkText(effect.text, scope);
				break;
			}
			case "attitude": {
				assertVisible(
					scope.audience,
					referenceAudience(effect.from, pack, scope),
				);
				assertVisible(
					scope.audience,
					referenceAudience(effect.to, pack, scope),
				);
				if (!pack.life.attitudes.some((axis) => axis.id === effect.axisId))
					throw Error("Unknown authoring attitude axis");
				checkNumber(effect.delta, scope);
				break;
			}
			case "goal":
				assertVisible(
					scope.audience,
					referenceAudience(effect.agent, pack, scope),
				);
				checkText(effect.description, scope);
				break;
		}
	}
}
/** Compile references, types, ranges and information-flow closure without evaluating any node. */
export function validateWorldSemantics(pack: WorldPack): void {
	if (
		pack.worldId !== pack.world.id ||
		pack.worldId !== pack.life.worldId ||
		pack.version !== pack.world.version
	)
		throw Error("Authoring world/version mismatch");
	knownAgents(pack.life.participants, pack.world.agents);
	knownAgents(
		pack.roles.map((r) => r.agentId),
		pack.world.agents,
	);
	if (pack.roles.length !== pack.world.agents.length)
		throw Error("Authoring requires explicit membership for each agent");
	// Definition occupancy is historical; the activation owner applies explicit relocations.
	const variables = new Map(pack.variables.map((v) => [v.id, v]));
	const scope = (audience: string[]): ExpressionScope => ({
		variables,
		audience,
		randoms: new Map(),
	});
	for (const variable of pack.variables) {
		knownAgents(variable.knownTo, pack.world.agents);
		checkVariableValue(variable, variable.initial);
	}
	for (const constraint of pack.constraints)
		checkBoolean(constraint.condition, scope(pack.world.agents));
	for (const rule of pack.rules) {
		knownAgents(rule.knownTo, pack.world.agents);
		const context = scope(rule.knownTo);
		checkBoolean(rule.condition, context);
		checkEffects(rule.effects, pack, context);
	}
	for (const lore of pack.lore) {
		const policy = lore.disclosure;
		knownAgents(policy.knowers, pack.world.agents);
		knownAgents(
			policy.disclosures.map((d) => d.agentId),
			policy.knowers,
		);
		// A publication permission cannot declassify a variable with only agent knowledge metadata.
		const context = scope([
			...new Set([...policy.knowers, ...policy.publication]),
		]);
		checkBoolean(lore.condition, context);
		checkText(lore.text, context);
		checkEffects(lore.effects, pack, context);
	}
	for (const family of pack.eventFamilies) {
		if (
			family.actorRoleIds.some(
				(id) =>
					!pack.roles.some((r) => r.roleId === id && r.status === "active"),
			)
		)
			throw Error("Unknown authoring actor role");
		const context = scope(pack.world.agents);
		checkBoolean(family.condition, context);
		checkEffects(family.effects, pack, context);
	}
}
