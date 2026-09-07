import {
	array,
	finite,
	flag,
	identifier,
	jsonBoundary,
	keyed,
	revision,
} from "./life-json.ts";
import {
	growthAgent,
	parseBelief,
	parseCheckpoint,
	parseClaim,
	parseExperience,
	parseGrowth,
	refKey,
} from "./life-record-validation.ts";
import type { LifeState } from "./life-types.ts";
import { fields } from "./validation.ts";

function stateVersion(value: unknown): 1 {
	if (value !== 1) throw Error("Unsupported LIFE version");
	return 1;
}
function profileRevision(value: unknown): number | null {
	return value === null ? null : revision(value, 1);
}
export function parseLifeState(value: unknown): LifeState {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"revision",
		"worldRevision",
		"definitionRevision",
		"baseWorldRevision",
		"claims",
		"beliefs",
		"experiences",
		"traits",
		"habits",
		"attitudes",
		"growthHistory",
		"checkpoint",
	]);
	const state: LifeState = {
		version: stateVersion(value.version),
		worldId: identifier(value.worldId),
		revision: revision(value.revision),
		worldRevision: revision(value.worldRevision),
		definitionRevision: revision(value.definitionRevision, 1),
		baseWorldRevision: revision(value.baseWorldRevision),
		claims: keyed(array(value.claims, parseClaim), (x) => x.id, false),
		beliefs: keyed(array(value.beliefs, parseBelief), (x) => x.id, false),
		experiences: keyed(
			array(value.experiences, parseExperience),
			(x) => x.id,
			false,
		),
		traits: keyed(
			array(value.traits, (entry) => {
				fields(entry, ["agentId", "axisId", "value", "profileRevision"]);
				return {
					agentId: identifier(entry.agentId),
					axisId: identifier(entry.axisId),
					value: finite(entry.value),
					profileRevision: profileRevision(entry.profileRevision),
				};
			}),
			(x) => `${x.agentId}:${x.axisId}`,
		),
		habits: keyed(
			array(value.habits, (entry) => {
				fields(entry, ["agentId", "habitId", "value", "profileRevision"]);
				return {
					agentId: identifier(entry.agentId),
					habitId: identifier(entry.habitId),
					value: flag(entry.value),
					profileRevision: profileRevision(entry.profileRevision),
				};
			}),
			(x) => `${x.agentId}:${x.habitId}`,
		),
		attitudes: keyed(
			array(value.attitudes, (entry) => {
				fields(entry, [
					"fromAgentId",
					"toAgentId",
					"axisId",
					"value",
					"profileRevision",
				]);
				return {
					fromAgentId: identifier(entry.fromAgentId),
					toAgentId: identifier(entry.toAgentId),
					axisId: identifier(entry.axisId),
					value: finite(entry.value),
					profileRevision: profileRevision(entry.profileRevision),
				};
			}),
			(x) => `${x.fromAgentId}:${x.toAgentId}:${x.axisId}`,
		),
		growthHistory: array(value.growthHistory, (entry) => {
			fields(entry, ["lifeRevision", "profileRevision", "delta"]);
			return {
				lifeRevision: revision(entry.lifeRevision, 1),
				profileRevision: revision(entry.profileRevision, 1),
				delta: parseGrowth(entry.delta),
			};
		}),
		checkpoint: parseCheckpoint(value.checkpoint),
	};
	if (
		!Number.isSafeInteger(state.baseWorldRevision + state.revision) ||
		state.worldRevision !== state.baseWorldRevision + state.revision
	)
		throw Error("LIFE paired revision mismatch");
	for (const record of state.growthHistory)
		if (record.lifeRevision > state.revision)
			throw Error("Future LIFE growth history");
	validateLocalReferences(state);
	return state;
}

/** Checks intrinsic state references without needing a database or paired world snapshot. */
function validateLocalReferences(state: LifeState): void {
	if (
		state.revision === 0 &&
		(state.claims.length ||
			state.beliefs.length ||
			state.experiences.length ||
			state.growthHistory.length)
	)
		throw Error("LIFE baseline cannot contain invented history");
	const eventRevision = (event: string): number => {
		const [world, value] = event.split(":");
		if (world !== state.worldId || Number(value) > state.worldRevision)
			throw Error("Unknown or future LIFE event reference");
		return Number(value);
	};
	const claims = new Map(state.claims.map((x) => [x.id, x]));
	const experiences = new Map(state.experiences.map((x) => [x.id, x]));
	const priorClaims = new Set<string>();
	const replacedClaims = new Set<string>();
	for (const claim of state.claims) {
		eventRevision(claim.sourceEventId);
		if (claim.supersedes !== null) {
			if (
				!priorClaims.has(claim.supersedes) ||
				replacedClaims.has(claim.supersedes)
			)
				throw Error("Invalid LIFE claim supersession");
			replacedClaims.add(claim.supersedes);
		}
		priorClaims.add(claim.id);
	}
	for (const experience of state.experiences) {
		const event = eventRevision(experience.eventId);
		for (const ref of experience.claims)
			if (ref.kind === "life_claim") {
				const claim = claims.get(ref.id);
				if (!claim || eventRevision(claim.sourceEventId) > event)
					throw Error("Unknown or future LIFE claim reference");
				if (!claim.disclosure.knowers.includes(experience.agentId))
					throw Error("LIFE experience exceeds statement knowledge");
			}
	}
	const priorBeliefs = new Map<string, LifeState["beliefs"][number]>();
	const replacedBeliefs = new Set<string>();
	const active = new Set<string>();
	for (const belief of state.beliefs) {
		for (const source of belief.experienceIds) {
			const experience = experiences.get(source);
			if (
				!experience ||
				experience.agentId !== belief.agentId ||
				!experience.claims.some((x) => refKey(x) === refKey(belief.claim))
			)
				throw Error("Invalid LIFE belief evidence");
		}
		if (belief.supersedes !== null) {
			const prior = priorBeliefs.get(belief.supersedes);
			if (
				!prior ||
				prior.agentId !== belief.agentId ||
				replacedBeliefs.has(prior.id)
			)
				throw Error("Invalid LIFE belief supersession");
			replacedBeliefs.add(prior.id);
			active.delete(`${prior.agentId}:${refKey(prior.claim)}`);
		}
		const key = `${belief.agentId}:${refKey(belief.claim)}`;
		if (active.has(key)) throw Error("Duplicate active LIFE belief");
		active.add(key);
		priorBeliefs.set(belief.id, belief);
	}
	for (const record of state.growthHistory)
		for (const ref of record.delta.evidenceIds) {
			const experience = experiences.get(ref);
			if (
				!experience ||
				experience.agentId !== growthAgent(record.delta) ||
				eventRevision(experience.eventId) >
					state.baseWorldRevision + record.lifeRevision
			)
				throw Error("Invalid LIFE growth evidence");
		}
}
