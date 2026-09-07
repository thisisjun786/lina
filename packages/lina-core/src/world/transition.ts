import type { WorldDefinition, WorldProposal, WorldSnapshot } from "./types.ts";
import { integer, knownAgents, withinCapacity } from "./validation.ts";

export function initialSnapshot(definition: WorldDefinition): WorldSnapshot {
	const snapshot = structuredClone({
		definition,
		revision: 0,
		simulationTime: definition.initialTime,
		scenes: structuredClone(definition.scenes),
		facts: definition.lore.map((fact) => ({ ...fact, sourceEventId: null })),
	});
	withinCapacity(snapshot);
	return snapshot;
}
export function eventId(worldId: string, revision: number): string {
	return `${worldId}:${revision}`;
}
/** A pure preview. Only WorldStore.accept commits its result. */
export function transition(
	current: WorldSnapshot,
	proposal: WorldProposal,
): WorldSnapshot {
	if (current.definition.id !== proposal.worldId) throw Error("World mismatch");
	if (current.revision !== proposal.expectedRevision)
		throw Error("World revision conflict");
	if (proposal.simulationTime < current.simulationTime)
		throw Error("World time cannot go backwards");
	knownAgents(proposal.actorIds, current.definition.agents);
	knownAgents(proposal.audience, current.definition.agents);
	if (proposal.kind === "tick") {
		if (
			proposal.sceneId !== null ||
			proposal.actorIds.length ||
			proposal.audience.length ||
			proposal.summary ||
			proposal.facts.length ||
			proposal.moves.length
		)
			throw Error("Quiet tick cannot contain activity");
	} else {
		const scene = current.scenes.find((s) => s.id === proposal.sceneId);
		if (!scene) throw Error("Unknown world scene");
		if (!proposal.actorIds.length || !proposal.summary.trim())
			throw Error("Activity requires actors and summary");
		if (
			proposal.actorIds.some(
				(a) =>
					!scene.occupants.includes(a) &&
					!proposal.moves.some(
						(move) => move.agentId === a && move.sceneId === scene.id,
					),
			)
		)
			throw Error("Activity actor is outside the scene");
		if (proposal.actorIds.some((a) => !proposal.audience.includes(a)))
			throw Error("Activity audience must include actors");
	}
	for (const fact of proposal.facts) {
		if (fact.knownTo.some((a) => !proposal.audience.includes(a)))
			throw Error("Fact knowledge exceeds event audience");
		if (current.facts.some((f) => f.id === fact.id))
			throw Error("World fact already exists");
	}
	const next = structuredClone(current);
	next.revision++;
	integer(next.revision, "revision", 1);
	next.simulationTime = proposal.simulationTime;
	for (const move of proposal.moves) {
		if (!proposal.actorIds.includes(move.agentId))
			throw Error("Only an event actor may move");
		const target = next.scenes.find((s) => s.id === move.sceneId);
		if (move.sceneId !== null && !target)
			throw Error("Unknown destination scene");
		for (const scene of next.scenes)
			scene.occupants = scene.occupants.filter((a) => a !== move.agentId);
		target?.occupants.push(move.agentId);
	}
	next.facts.push(
		...proposal.facts.map((fact) => ({
			...structuredClone(fact),
			sourceEventId: eventId(proposal.worldId, next.revision),
		})),
	);
	withinCapacity(next);
	return next;
}
