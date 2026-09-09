import { isDeepStrictEqual } from "node:util";
import type { WorldDefinitionProposal, WorldSnapshot } from "./types.ts";
import { integer, knownAgents, withinCapacity } from "./validation.ts";

/** Version changes preserve historical people, clocks and facts. Placement changes are explicit. */
export function applyWorldDefinition(
	current: WorldSnapshot,
	proposal: WorldDefinitionProposal,
): WorldSnapshot {
	const before = current.definition,
		after = proposal.definition;
	if (
		proposal.sceneId !== null ||
		proposal.actorIds.length ||
		proposal.audience.length ||
		proposal.summary ||
		proposal.facts.length ||
		proposal.moves.length
	)
		throw Error("Definition change cannot narrate activity");
	if (
		after.id !== before.id ||
		after.version !== before.version + 1 ||
		after.timeUnit !== before.timeUnit ||
		after.initialTime !== before.initialTime
	)
		throw Error("Invalid world definition version or historical clock change");
	knownAgents(before.agents, after.agents);
	for (const fact of before.lore)
		if (
			!isDeepStrictEqual(
				fact,
				after.lore.find((item) => item.id === fact.id),
			)
		)
			throw Error("Historical lore cannot be removed or reinterpreted");
	for (const agent of before.agents) {
		const oldScene =
			before.scenes.find((scene) => scene.occupants.includes(agent))?.id ??
			null;
		const newScene =
			after.scenes.find((scene) => scene.occupants.includes(agent))?.id ?? null;
		const mapping = proposal.relocations.find((move) => move.agentId === agent);
		if (
			oldScene !== newScene &&
			(!mapping || (newScene !== null && mapping.sceneId !== newScene))
		)
			throw Error("Existing agent placement requires an explicit relocation");
	}
	const scenes = after.scenes.map((scene) => ({
		...structuredClone(scene),
		occupants: scene.occupants.filter(
			(agent) => !before.agents.includes(agent),
		),
	}));
	for (const move of proposal.relocations) {
		knownAgents([move.agentId], after.agents);
		if (
			move.sceneId !== null &&
			!scenes.some((scene) => scene.id === move.sceneId)
		)
			throw Error("Unknown relocation destination");
	}
	for (const scene of current.scenes)
		for (const agent of scene.occupants) {
			if (proposal.relocations.some((move) => move.agentId === agent)) continue;
			const destination = scenes.find((item) => item.id === scene.id);
			if (!destination)
				throw Error("Occupied scene removal requires explicit relocation");
			destination.occupants.push(agent);
		}
	for (const move of proposal.relocations) {
		for (const scene of scenes)
			scene.occupants = scene.occupants.filter(
				(agent) => agent !== move.agentId,
			);
		scenes
			.find((scene) => scene.id === move.sceneId)
			?.occupants.push(move.agentId);
	}
	const next: WorldSnapshot = {
		...structuredClone(current),
		definition: structuredClone(after),
		scenes,
		revision: current.revision + 1,
		simulationTime: proposal.simulationTime,
	};
	integer(next.revision, "world revision", 1);
	for (const fact of after.lore.filter(
		(item) => !before.lore.some((old) => old.id === item.id),
	)) {
		if (next.facts.some((item) => item.id === fact.id))
			throw Error("New lore conflicts with a historical fact");
		next.facts.push({
			...structuredClone(fact),
			sourceEventId: `${after.id}:${next.revision}`,
		});
	}
	withinCapacity(next);
	return next;
}
