import { knowsClaimAt } from "./life-knowledge.ts";
import type {
	AuthorInspection,
	AuthorScope,
	ClaimRef,
	DisclosurePolicy,
	IdentityPolicySnapshot,
	LifeDefinition,
	LifePerception,
	LifeState,
	LifeViewLimits,
	PerceptionScope,
	ProjectionPolicy,
	PublicationScope,
	PublicationView,
	SharedPersonaView,
	WorldBinding,
} from "./life-types.ts";
import {
	parseAuthorScope,
	parseIdentityPolicy,
	parseLifeDefinition,
	parseLifeState,
	parseLifeViewLimits,
	parsePerceptionScope,
	parseProjectionPolicy,
	parsePublicationScope,
	parseWorldBinding,
} from "./life-validation.ts";
import type { WorldContext, WorldEvent, WorldSnapshot } from "./types.ts";
import { knownAgents } from "./validation.ts";
import type { WorkSubject } from "./work-types.ts";

function paired(world: WorldSnapshot, life: LifeState, worldId: string): void {
	if (
		world.definition.id !== worldId ||
		life.worldId !== worldId ||
		life.worldRevision !== world.revision
	)
		throw Error("LIFE projection world/revision mismatch");
}
function definitionFor(life: LifeState, def: LifeDefinition): void {
	if (life.worldId !== def.worldId || life.definitionRevision !== def.revision)
		throw Error("LIFE projection definition mismatch");
}
function statement(
	ref: ClaimRef,
	agentId: string,
	world: WorldSnapshot,
	life: LifeState,
): string | undefined {
	if (!knowsClaimAt(ref, agentId, world, life)) return undefined;
	return (ref.kind === "world_fact" ? world.facts : life.claims).find(
		(x) => x.id === ref.id,
	)?.text;
}
function sceneFor(
	world: WorldSnapshot,
	agentId: string,
): WorldContext["scene"] {
	const scene = world.scenes.find((x) => x.occupants.includes(agentId));
	const place = world.definition.places.find((x) => x.id === scene?.placeId);
	return scene && place
		? {
				id: scene.id,
				place: structuredClone(place),
				description: scene.description,
				occupants: [...scene.occupants],
			}
		: null;
}
/** Only permitted records reach this collector; hidden records cannot affect truncation. */
function collector(view: { truncated: boolean }, limits: LifeViewLimits) {
	const budget = parseLifeViewLimits(limits);
	let count = 0;
	if (JSON.stringify(view).length > budget.maxChars)
		throw Error("LIFE view budget cannot hold provenance");
	return {
		add<T>(target: T[], item: T): void {
			if (count >= budget.maxRecords) {
				view.truncated = true;
				return;
			}
			target.push(structuredClone(item));
			if (JSON.stringify(view).length > budget.maxChars) {
				target.pop();
				view.truncated = true;
			} else count++;
		},
		scene(
			target: { scene: WorldContext["scene"] },
			scene: WorldContext["scene"],
		): void {
			if (!scene) return;
			if (count >= budget.maxRecords) {
				view.truncated = true;
				return;
			}
			target.scene = scene;
			if (JSON.stringify(view).length > budget.maxChars) {
				target.scene = null;
				view.truncated = true;
			} else count++;
		},
	};
}
export function projectAuthorInspection(
	world: WorldSnapshot,
	life: LifeState,
	definition: LifeDefinition,
	events: WorldEvent[],
	scope: AuthorScope,
): AuthorInspection {
	const checked = parseAuthorScope(scope);
	paired(world, life, checked.worldId);
	definitionFor(life, definition);
	return structuredClone({ world, life, definition, events });
}
export function projectLifePerception(
	worldSource: WorldSnapshot,
	lifeSource: LifeState,
	definition: LifeDefinition,
	scope: PerceptionScope,
	limits: LifeViewLimits,
	workAllowed: (subject: WorkSubject) => boolean = () => true,
): LifePerception {
	const checked = parsePerceptionScope(scope);
	const world = {
		...worldSource,
		facts: worldSource.facts.filter((f) =>
			workAllowed({ kind: "world_fact", id: f.id }),
		),
	};
	const life = {
		...lifeSource,
		claims: lifeSource.claims.filter((c) =>
			workAllowed({ kind: "life_claim", id: c.id }),
		),
		experiences: lifeSource.experiences.filter((e) =>
			workAllowed({ kind: "experience", id: e.id }),
		),
	};
	paired(world, life, checked.worldId);
	definitionFor(life, definition);
	knownAgents([checked.agentId], definition.participants);
	const agentId = checked.agentId;
	const view: LifePerception = {
		version: 1,
		worldId: life.worldId,
		agentId,
		lifeRevision: life.revision,
		scene: null,
		facts: [],
		claims: [],
		beliefs: [],
		experiences: [],
		attitudes: [],
		truncated: false,
	};
	const collect = collector(view, limits);
	const scene = sceneFor(world, agentId);
	if (
		scene &&
		workAllowed({ kind: "world_scene", id: scene.id }) &&
		definition.projection.disclosures.some(
			(x) =>
				x.subject.kind === "world_scene" &&
				x.subject.id === scene.id &&
				x.policy.knowers.includes(agentId),
		)
	)
		collect.scene(view, scene);
	for (const fact of world.facts.filter((x) =>
		knowsClaimAt({ kind: "world_fact", id: x.id }, agentId, world, life),
	))
		collect.add(view.facts, { id: fact.id, text: fact.text });
	const visibleClaims = life.claims.filter((x) =>
		knowsClaimAt({ kind: "life_claim", id: x.id }, agentId, world, life),
	);
	const supersededClaims = new Set(
		visibleClaims.flatMap((x) => (x.supersedes === null ? [] : [x.supersedes])),
	);
	for (const claim of visibleClaims.filter((x) => !supersededClaims.has(x.id)))
		collect.add(view.claims, { id: claim.id, text: claim.text });
	const visibleBeliefs = life.beliefs.filter(
		(x) =>
			x.agentId === agentId &&
			statement(x.claim, agentId, world, life) !== undefined,
	);
	const supersededBeliefs = new Set(
		visibleBeliefs.flatMap((x) =>
			x.supersedes === null ? [] : [x.supersedes],
		),
	);
	for (const belief of visibleBeliefs.filter(
		(x) => !supersededBeliefs.has(x.id),
	)) {
		const text = statement(belief.claim, agentId, world, life);
		if (text === undefined) continue;
		collect.add(view.beliefs, {
			id: belief.id,
			claim: belief.claim,
			text,
			stance: belief.stance,
			confidence: belief.confidence,
		});
	}
	for (const experience of life.experiences.filter(
		(x) => x.agentId === agentId,
	))
		collect.add(view.experiences, {
			id: experience.id,
			channel: experience.channel,
			claims: experience.claims.filter(
				(x) => statement(x, agentId, world, life) !== undefined,
			),
			simulationTime: experience.simulationTime,
		});
	for (const attitude of life.attitudes.filter(
		(x) => x.fromAgentId === agentId && x.profileRevision !== null,
	)) {
		const axis = definition.attitudes.find((x) => x.id === attitude.axisId);
		if (axis)
			collect.add(view.attitudes, {
				toAgentId: attitude.toAgentId,
				label: axis.label,
				value: attitude.value,
			});
	}
	return view;
}
export function projectSharedPersona(
	life: LifeState,
	definition: LifeDefinition,
	binding: WorldBinding,
	identity: IdentityPolicySnapshot,
	limits: LifeViewLimits,
): SharedPersonaView | null {
	const selected = parseWorldBinding(binding);
	const policies = parseIdentityPolicy(identity);
	if (selected.worldId === null) return null;
	const state = parseLifeState(life);
	const def = parseLifeDefinition(definition);
	definitionFor(state, def);
	if (
		selected.worldId !== life.worldId ||
		selected.projectionPolicyRevision !== def.projection.revision
	)
		throw Error("LIFE binding conflict");
	knownAgents([selected.agentId], def.participants);
	const profile = policies.profiles.find((x) => x.agentId === selected.agentId);
	if (!profile) throw Error("Missing LIFE identity policy");
	const view: SharedPersonaView = {
		version: 1,
		worldId: life.worldId,
		agentId: selected.agentId,
		lifeRevision: life.revision,
		bindingRevision: selected.revision,
		projectionPolicyRevision: def.projection.revision,
		profileRevision: profile.profileRevision,
		traits: [],
		habits: [],
		attitudes: [],
		truncated: false,
	};
	const collect = collector(view, limits);
	if (profile.evolution === "manual") return view;
	const traits = state.traits.filter(
		(x) =>
			x.agentId === profile.agentId &&
			x.profileRevision === profile.profileRevision &&
			def.projection.sharedTraitIds.includes(x.axisId) &&
			!profile.lockedTraitIds.includes(x.axisId),
	);
	const habits = state.habits.filter(
		(x) =>
			x.agentId === profile.agentId &&
			x.profileRevision === profile.profileRevision &&
			def.projection.sharedHabitIds.includes(x.habitId) &&
			!profile.lockedHabitIds.includes(x.habitId),
	);
	const attitudes = state.attitudes.filter(
		(x) =>
			x.fromAgentId === profile.agentId &&
			x.profileRevision === profile.profileRevision &&
			def.projection.sharedAttitudeIds.includes(x.axisId) &&
			!profile.lockedAttitudeIds.includes(x.axisId),
	);
	for (const trait of traits) {
		const axis = def.traits.find((x) => x.id === trait.axisId);
		if (axis)
			collect.add(view.traits, { label: axis.label, value: trait.value });
	}
	for (const habit of habits) {
		const axis = def.habits.find((x) => x.id === habit.habitId);
		if (axis)
			collect.add(view.habits, { label: axis.label, value: habit.value });
	}
	for (const attitude of attitudes) {
		const axis = def.attitudes.find((x) => x.id === attitude.axisId);
		if (axis)
			collect.add(view.attitudes, {
				toAgentId: attitude.toAgentId,
				label: axis.label,
				value: attitude.value,
			});
	}
	return view;
}
function publicationAllowed(
	policy: DisclosurePolicy | undefined,
	scope: PublicationScope,
): boolean {
	return (
		!!policy &&
		policy.knowers.includes(scope.agentId) &&
		policy.publication.includes(scope.recipientId) &&
		policy.disclosures.some(
			(x) => x.agentId === scope.agentId && x.recipientId === scope.recipientId,
		)
	);
}
/** Historical material is selected only after checking the CURRENT complete permission policy. */
export function projectPublication(
	world: WorldSnapshot,
	life: LifeState,
	events: WorldEvent[],
	currentPolicy: ProjectionPolicy,
	scope: PublicationScope,
	limits: LifeViewLimits,
	workAllowed: (subject: WorkSubject) => boolean = () => true,
): PublicationView {
	const checked = parsePublicationScope(scope);
	paired(world, life, checked.worldId);
	knownAgents([checked.agentId], world.definition.agents);
	const policy = parseProjectionPolicy(currentPolicy);
	const allowed = (
		kind: "world_event" | "world_scene" | "world_fact" | "life_claim",
		id: string,
	) =>
		workAllowed({ kind, id }) &&
		publicationAllowed(
			policy.disclosures.find(
				(x) => x.subject.kind === kind && x.subject.id === id,
			)?.policy,
			checked,
		);
	const view: PublicationView = {
		version: 1,
		worldId: life.worldId,
		recipientId: checked.recipientId,
		lifeRevision: life.revision,
		projectionPolicyRevision: policy.revision,
		events: [],
		facts: [],
		claims: [],
		scene: null,
		truncated: false,
	};
	const collect = collector(view, limits);
	for (const event of events.filter(
		(x) =>
			x.worldId === checked.worldId &&
			x.revision <= world.revision &&
			x.audience.includes(checked.agentId) &&
			allowed("world_event", x.id),
	))
		collect.add(view.events, {
			id: event.id,
			simulationTime: event.simulationTime,
			summary: event.summary,
		});
	for (const fact of world.facts.filter(
		(x) =>
			knowsClaimAt(
				{ kind: "world_fact", id: x.id },
				checked.agentId,
				world,
				life,
			) && allowed("world_fact", x.id),
	))
		collect.add(view.facts, { id: fact.id, text: fact.text });
	for (const claim of life.claims.filter(
		(x) =>
			knowsClaimAt(
				{ kind: "life_claim", id: x.id },
				checked.agentId,
				world,
				life,
			) && allowed("life_claim", x.id),
	))
		collect.add(view.claims, { id: claim.id, text: claim.text });
	const scene = sceneFor(world, checked.agentId);
	if (scene && allowed("world_scene", scene.id)) collect.scene(view, scene);
	return view;
}

/** Compose keyed values before the existing policy projection resolves labels. */
export function projectCurrentPersona(
	life: LifeState,
	definition: LifeDefinition,
	binding: WorldBinding,
	identity: IdentityPolicySnapshot,
	limits: LifeViewLimits,
) {
	const worldView = projectSharedPersona(
		life,
		definition,
		binding,
		identity,
		limits,
	);
	if (!worldView) return null;
	const policies = parseIdentityPolicy(identity);
	const policy = policies.profiles.find((p) => p.agentId === binding.agentId);
	if (!policy) throw Error("Missing current persona identity");
	const personalPolicy =
		policies.version === 2
			? policies.profiles.find((p) => p.agentId === binding.agentId)
			: undefined;
	const personal = personalPolicy?.personalBehavior ?? null;
	const stamp = personalPolicy?.sourceStamp ?? null;
	if (!personal || !stamp || policy.evolution === "manual")
		return {
			version: 1 as const,
			worldView,
			personalBehavior: null,
			sourceStamp: null,
			composedBehavior: {
				traits: worldView.traits,
				habits: worldView.habits,
				attitudes: worldView.attitudes,
			},
			truncated: worldView.truncated,
		};
	if (
		stamp.definitionRevision !== definition.revision ||
		stamp.projectionRevision !== definition.projection.revision
	)
		throw Error("Personal behavior definition revision mismatch");
	const composed = {
		...life,
		traits: life.traits.map((row) => ({ ...row })),
		habits: life.habits.map((row) => ({ ...row })),
	};
	for (const row of personal.traits) {
		const axis = definition.traits.find((a) => a.id === row.axisId);
		if (
			!axis ||
			row.value < axis.min ||
			row.value > axis.max ||
			!definition.projection.sharedTraitIds.includes(row.axisId)
		)
			throw Error("Personal trait outside permitted definition");
		if (policy.lockedTraitIds.includes(row.axisId)) continue;
		const current = composed.traits.find(
			(r) => r.agentId === binding.agentId && r.axisId === row.axisId,
		);
		if (!current) throw Error("Missing personal trait base");
		const worldValue =
			current.profileRevision === policy.profileRevision
				? current.value
				: axis.initial;
		current.value = Math.min(
			axis.max,
			Math.max(axis.min, worldValue + row.value - axis.initial),
		);
		current.profileRevision = policy.profileRevision;
	}
	for (const row of personal.habits) {
		const axis = definition.habits.find((a) => a.id === row.habitId);
		if (!axis || !definition.projection.sharedHabitIds.includes(row.habitId))
			throw Error("Personal habit outside permitted definition");
		if (policy.lockedHabitIds.includes(row.habitId)) continue;
		const current = composed.habits.find(
			(r) => r.agentId === binding.agentId && r.habitId === row.habitId,
		);
		if (!current) throw Error("Missing personal habit base");
		if (current.profileRevision !== policy.profileRevision)
			current.value = row.value;
		current.profileRevision = policy.profileRevision;
	}
	const view = projectSharedPersona(
		composed,
		definition,
		binding,
		policies,
		limits,
	);
	if (!view) throw Error("Missing composed persona");
	return {
		version: 1 as const,
		worldView,
		personalBehavior: personal,
		sourceStamp: stamp,
		composedBehavior: {
			traits: view.traits,
			habits: view.habits,
			attitudes: view.attitudes,
		},
		truncated: view.truncated,
	};
}
