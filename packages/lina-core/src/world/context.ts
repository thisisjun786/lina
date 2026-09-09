import type {
	WorldContext,
	WorldContextLimits,
	WorldEvent,
	WorldSnapshot,
} from "./types.ts";
import { integer, MAX_WORLD_BYTES } from "./validation.ts";

export function validateContextLimits(limits: WorldContextLimits): void {
	integer(limits.maxChars, "context budget", 1, MAX_WORLD_BYTES);
	integer(limits.maxFacts, "fact budget", 0, 4096);
	integer(limits.maxEvents, "event budget", 0, 4096);
}

export function projectContext(
	snapshot: WorldSnapshot,
	agentId: string,
	events: WorldEvent[],
	limits: WorldContextLimits,
): WorldContext {
	validateContextLimits(limits);
	if (!snapshot.definition.agents.includes(agentId))
		throw Error("Unknown world agent");
	const scene = snapshot.scenes.find((s) => s.occupants.includes(agentId));
	const place = snapshot.definition.places.find((p) => p.id === scene?.placeId);
	const context: WorldContext = {
		worldId: snapshot.definition.id,
		agentId,
		definitionVersion: snapshot.definition.version,
		revision: snapshot.revision,
		simulationTime: snapshot.simulationTime,
		timeUnit: snapshot.definition.timeUnit,
		origin: "fictional",
		scene:
			scene && place
				? {
						id: scene.id,
						place: structuredClone(place),
						description: scene.description,
						occupants: [...scene.occupants],
					}
				: null,
		facts: [],
		events: [],
		truncated: false,
	};
	if (JSON.stringify(context).length > limits.maxChars) {
		context.scene = null;
		context.truncated = true;
	}
	if (JSON.stringify(context).length > limits.maxChars)
		throw Error("World context budget cannot hold provenance");
	const fits = () => JSON.stringify(context).length <= limits.maxChars;
	for (const fact of snapshot.facts) {
		if (!fact.knownTo.includes(agentId)) continue;
		if (context.facts.length >= limits.maxFacts) {
			context.truncated = true;
			continue;
		}
		context.facts.push({
			id: fact.id,
			text: fact.text,
			sourceEventId: fact.sourceEventId,
		});
		if (!fits()) {
			context.facts.pop();
			context.truncated = true;
		}
	}
	for (const event of events) {
		if (!event.audience.includes(agentId)) continue;
		if (context.events.length >= limits.maxEvents) {
			context.truncated = true;
			continue;
		}
		context.events.push({
			id: event.id,
			revision: event.revision,
			simulationTime: event.simulationTime,
			summary: event.summary,
			sceneId: event.sceneId,
			actorIds: [...event.actorIds],
		});
		if (!fits()) {
			context.events.pop();
			context.truncated = true;
		}
	}
	return context;
}
