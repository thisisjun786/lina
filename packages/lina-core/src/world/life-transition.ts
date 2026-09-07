import {
	canonicalLifeJson,
	finite,
	keyed,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import {
	emptyCheckpoint,
	growthAgent,
	growthKey,
} from "./life-record-validation.ts";
import type {
	AgentExperience,
	GrowthDelta,
	IdentityPolicySnapshot,
	IdentityProfilePolicy,
	LifeCommit,
	LifeDefinition,
	LifeState,
	NumericAxis,
} from "./life-types.ts";
import {
	parseIdentityPolicy,
	parseLifeCommit,
	parseLifeDefinition,
	parseLifeState,
} from "./life-validation.ts";
import { eventId, transition } from "./transition.ts";
import type { WorldSnapshot } from "./types.ts";
import { knownAgents, withinCapacity } from "./validation.ts";

export function initialLifeState(
	world: WorldSnapshot,
	definition: LifeDefinition,
): LifeState {
	const def = parseLifeDefinition(definition);
	if (world.definition.id !== def.worldId) throw Error("LIFE world mismatch");
	revision(world.revision);
	knownAgents(def.participants, world.definition.agents);
	// Bound the Cartesian expansion before allocating it, not after an oversized snapshot exists.
	const count = def.participants.length;
	if (
		[
			count * def.traits.length,
			count * def.habits.length,
			count * (count - 1) * def.attitudes.length,
		].some((size) => size > MAX_LIFE_ITEMS)
	)
		throw Error("LIFE state capacity exceeded");
	const state: LifeState = {
		version: 1,
		worldId: def.worldId,
		revision: 0,
		worldRevision: world.revision,
		definitionRevision: def.revision,
		baseWorldRevision: world.revision,
		claims: [],
		beliefs: [],
		experiences: [],
		growthHistory: [],
		checkpoint: emptyCheckpoint(),
		traits: def.participants.flatMap((agentId) =>
			def.traits.map((axis) => ({
				agentId,
				axisId: axis.id,
				value: axis.initial,
				profileRevision: null,
			})),
		),
		habits: def.participants.flatMap((agentId) =>
			def.habits.map((habit) => ({
				agentId,
				habitId: habit.id,
				value: habit.initial,
				profileRevision: null,
			})),
		),
		attitudes: def.participants.flatMap((fromAgentId) =>
			def.participants
				.filter((to) => to !== fromAgentId)
				.flatMap((toAgentId) =>
					def.attitudes.map((axis) => ({
						fromAgentId,
						toAgentId,
						axisId: axis.id,
						value: axis.initial,
						profileRevision: null,
					})),
				),
		),
	};
	return parseLifeState(state);
}
function resolveClaim(
	ref: { kind: "world_fact" | "life_claim"; id: string },
	state: LifeState,
	world: WorldSnapshot,
): void {
	if (
		!(ref.kind === "world_fact" ? world.facts : state.claims).some(
			(x) => x.id === ref.id,
		)
	)
		throw Error("Unknown LIFE claim reference");
}
function experienceRefs(
	experience: AgentExperience,
	state: LifeState,
	world: WorldSnapshot,
	def: LifeDefinition,
): void {
	knownAgents([experience.agentId], def.participants);
	if (experience.simulationTime > world.simulationTime)
		throw Error("Future LIFE experience time");
	for (const ref of experience.claims) {
		resolveClaim(ref, state, world);
		if (ref.kind === "world_fact") {
			const source = world.facts.find((x) => x.id === ref.id)?.sourceEventId;
			if (
				source &&
				Number(source.split(":")[1]) > Number(experience.eventId.split(":")[1])
			)
				throw Error("LIFE experience references a future fact");
		}
		const knowers =
			ref.kind === "world_fact"
				? world.facts.find((x) => x.id === ref.id)?.knownTo
				: state.claims.find((x) => x.id === ref.id)?.disclosure.knowers;
		if (!knowers?.includes(experience.agentId))
			throw Error("LIFE experience exceeds statement knowledge");
	}
}
function validateKnowledge(
	state: LifeState,
	world: WorldSnapshot,
	def: LifeDefinition,
): void {
	// Intrinsic claim/belief/supersession links were already checked by parseLifeState.
	for (const claim of state.claims) {
		knownAgents(claim.disclosure.knowers, def.participants);
		knownAgents(
			claim.disclosure.disclosures.map((x) => x.agentId),
			def.participants,
		);
	}
	for (const experience of state.experiences)
		experienceRefs(experience, state, world, def);
	for (const belief of state.beliefs) {
		knownAgents([belief.agentId], def.participants);
		resolveClaim(belief.claim, state, world);
	}
}
function inBounds(value: number, axis: NumericAxis | undefined): void {
	if (!axis || finite(value) < axis.min || value > axis.max)
		throw Error("Unknown LIFE axis or value outside bounds");
}
function applyGrowth(
	state: LifeState,
	def: LifeDefinition,
	delta: GrowthDelta,
	profileRevision: number,
): void {
	if (delta.kind === "trait") {
		inBounds(
			delta.next,
			def.traits.find((x) => x.id === delta.axisId),
		);
		const row = state.traits.find(
			(x) => x.agentId === delta.agentId && x.axisId === delta.axisId,
		);
		if (
			!row ||
			row.value !== delta.previous ||
			(row.profileRevision !== null && row.profileRevision > profileRevision)
		)
			throw Error("LIFE trait conflict");
		row.value = delta.next;
		row.profileRevision = profileRevision;
	} else if (delta.kind === "habit") {
		const row = state.habits.find(
			(x) => x.agentId === delta.agentId && x.habitId === delta.habitId,
		);
		if (
			!row ||
			row.value !== delta.previous ||
			(row.profileRevision !== null && row.profileRevision > profileRevision)
		)
			throw Error("LIFE habit conflict");
		row.value = delta.next;
		row.profileRevision = profileRevision;
	} else {
		inBounds(
			delta.next,
			def.attitudes.find((x) => x.id === delta.axisId),
		);
		const row = state.attitudes.find(
			(x) =>
				x.fromAgentId === delta.fromAgentId &&
				x.toAgentId === delta.toAgentId &&
				x.axisId === delta.axisId,
		);
		if (
			!row ||
			row.value !== delta.previous ||
			(row.profileRevision !== null && row.profileRevision > profileRevision)
		)
			throw Error("LIFE attitude conflict");
		row.value = delta.next;
		row.profileRevision = profileRevision;
	}
}
function evidence(
	delta: GrowthDelta,
	state: LifeState,
	maxWorldRevision: number,
): void {
	for (const ref of delta.evidenceIds) {
		const item = state.experiences.find((x) => x.id === ref);
		if (
			!item ||
			item.agentId !== growthAgent(delta) ||
			Number(item.eventId.split(":")[1]) > maxWorldRevision
		)
			throw Error("Invalid LIFE growth evidence");
	}
}
/** Full semantic validator for independently loaded state plus its paired world/config. */
export function validateLifeState(
	state: LifeState,
	world: WorldSnapshot,
	definition: LifeDefinition,
): void {
	const parsed = parseLifeState(state);
	const def = parseLifeDefinition(definition);
	if (
		parsed.worldId !== world.definition.id ||
		parsed.worldId !== def.worldId ||
		parsed.worldRevision !== world.revision ||
		parsed.definitionRevision !== def.revision
	)
		throw Error("LIFE state/config/world mismatch");
	knownAgents(def.participants, world.definition.agents);
	validateKnowledge(parsed, world, def);
	const reconstructed = initialLifeState(world, def);
	let lastRevision = 0;
	const keys = new Set<string>();
	for (const record of parsed.growthHistory) {
		if (record.lifeRevision < lastRevision)
			throw Error("Unordered LIFE growth history");
		lastRevision = record.lifeRevision;
		const key = `${record.lifeRevision}:${growthKey(record.delta)}`;
		if (keys.has(key)) throw Error("Duplicate LIFE growth history");
		keys.add(key);
		evidence(
			record.delta,
			parsed,
			parsed.baseWorldRevision + record.lifeRevision,
		);
		applyGrowth(reconstructed, def, record.delta, record.profileRevision);
	}
	for (const field of ["traits", "habits", "attitudes"] as const)
		if (
			canonicalLifeJson(parsed[field]) !==
			canonicalLifeJson(reconstructed[field])
		)
			throw Error("LIFE growth state/history mismatch");
}
function policyFor(
	identity: IdentityPolicySnapshot,
	delta: GrowthDelta,
): IdentityProfilePolicy {
	const profile = identity.profiles.find(
		(x) => x.agentId === growthAgent(delta),
	);
	if (!profile || profile.evolution === "manual")
		throw Error("LIFE identity forbids growth");
	const locked =
		delta.kind === "habit"
			? profile.lockedHabitIds.includes(delta.habitId)
			: delta.kind === "trait"
				? profile.lockedTraitIds.includes(delta.axisId)
				: profile.lockedAttitudeIds.includes(delta.axisId);
	if (locked) throw Error("LIFE identity axis is locked");
	return profile;
}
export function applyLifeTransition(
	previousLife: LifeState,
	previousWorld: WorldSnapshot,
	nextWorld: WorldSnapshot,
	definition: LifeDefinition,
	commit: LifeCommit,
	identity: IdentityPolicySnapshot,
): LifeState {
	const def = parseLifeDefinition(definition);
	const proposal = parseLifeCommit(commit);
	const policies = parseIdentityPolicy(identity);
	validateLifeState(previousLife, previousWorld, def);
	if (
		proposal.expectedLifeRevision !== previousLife.revision ||
		proposal.definitionRevision !== def.revision
	)
		throw Error("LIFE revision conflict");
	if (
		canonicalLifeJson(transition(previousWorld, proposal.world)) !==
		canonicalLifeJson(nextWorld)
	)
		throw Error("LIFE next world mismatch");
	if (
		proposal.world.kind === "tick" &&
		(proposal.claims.length ||
			proposal.beliefs.length ||
			proposal.experiences.length ||
			proposal.growth.length ||
			proposal.effects.length)
	)
		throw Error("Quiet tick cannot contain LIFE activity");
	const next = parseLifeState(previousLife);
	next.revision = revision(next.revision + 1, 1);
	next.worldRevision = nextWorld.revision;
	next.claims.push(...proposal.claims);
	next.beliefs.push(...proposal.beliefs);
	next.experiences.push(...proposal.experiences);
	keyed(next.claims, (x) => x.id, false);
	keyed(next.beliefs, (x) => x.id, false);
	keyed(next.experiences, (x) => x.id, false);
	for (const experience of proposal.experiences) {
		if (experience.eventId === eventId(def.worldId, nextWorld.revision)) {
			if (experience.simulationTime !== proposal.world.simulationTime)
				throw Error("LIFE experience time mismatch");
			if (
				experience.channel === "direct" &&
				!proposal.world.actorIds.includes(experience.agentId)
			)
				throw Error("LIFE direct experience requires actor");
			if (
				experience.channel === "observed" &&
				!proposal.world.audience.includes(experience.agentId)
			)
				throw Error("LIFE observed experience requires audience");
		} else if (experience.simulationTime > previousWorld.simulationTime)
			throw Error("Future LIFE historical experience time");
	}
	for (const delta of proposal.growth) {
		const profile = policyFor(policies, delta);
		evidence(delta, next, nextWorld.revision);
		applyGrowth(next, def, delta, profile.profileRevision);
		next.growthHistory.push({
			lifeRevision: next.revision,
			profileRevision: profile.profileRevision,
			delta,
		});
	}
	for (const effect of proposal.effects)
		if (
			effect.worldId !== next.worldId ||
			effect.lifeRevision !== next.revision ||
			effect.payload.eventId !== eventId(next.worldId, next.worldRevision)
		)
			throw Error("LIFE effect ownership mismatch");
	next.checkpoint = proposal.checkpoint;
	withinCapacity(next);
	validateLifeState(next, nextWorld, def);
	return parseLifeState(next);
}
