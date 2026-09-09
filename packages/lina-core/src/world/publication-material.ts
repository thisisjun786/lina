import { identifiers, lifeDigest } from "./life-json.ts";
import type {
	LifeState,
	LifeViewLimits,
	ProjectionPolicy,
	SideEffectIntent,
} from "./life-types.ts";
import {
	type PublicationEventRules,
	publicationEventForRecipient,
} from "./publication-event-rules.ts";
import type {
	EventPublicationMaterial,
	PublicationMaterial,
} from "./publication-types.ts";
import type { WorldEvent, WorldSnapshot } from "./types.ts";
import { projectPublication } from "./views.ts";
import type { WorkSubject } from "./work-types.ts";

/** WorldStore supplies persisted history and current complete authority in one read transaction. */
export function selectPublicationMaterial(input: {
	world: WorldSnapshot;
	life: LifeState;
	event: WorldEvent;
	intent: SideEffectIntent;
	policy: ProjectionPolicy;
	authorAgentId: string;
	recipientIds: string[];
	definitionRevision: number;
	workRevision: number;
	workAncestryRevision: number;
	configRevision: number;
	settingsRevision: number;
	workEvidenceDigest: string;
	limits: LifeViewLimits;
	workAllowed: (subject: WorkSubject) => boolean;
	eventRules?: PublicationEventRules | undefined;
}): EventPublicationMaterial | null {
	const { world, life, event, intent } = input;
	const audience = identifiers(input.recipientIds);
	if (!audience.length) throw Error("Explicit publication audience required");
	if (
		event.id !== intent.payload.eventId ||
		event.worldId !== life.worldId ||
		intent.worldId !== life.worldId ||
		intent.lifeRevision !== life.revision ||
		event.revision !== world.revision
	)
		throw Error("Publication event history mismatch");
	const views = audience.map((recipientId) => {
		const selected = publicationEventForRecipient(
			event,
			input.policy,
			input.eventRules,
			input.authorAgentId,
			recipientId,
			input.workAllowed({ kind: "world_event", id: event.id }),
		);
		return projectPublication(
			world,
			life,
			[selected.event],
			selected.policy,
			{
				purpose: "publication",
				worldId: life.worldId,
				agentId: input.authorAgentId,
				recipientId,
			},
			input.limits,
			input.workAllowed,
		);
	});
	if (views.some((view) => !view.events.some((e) => e.id === event.id)))
		return null;
	const first = views[0];
	if (!first) throw Error("Missing publication audience");
	const common = <T extends { id: string }>(
		values: T[],
		select: (view: NonNullable<typeof first>) => T[],
	) =>
		values.filter((value) =>
			views.every((view) =>
				select(view).some((other) => lifeDigest(value) === lifeDigest(other)),
			),
		);
	const commonEvents = common(first.events, (view) => view.events);
	if (!commonEvents.some((value) => value.id === event.id)) return null;
	const statements: Array<{
		kind: "world_event" | "world_fact" | "life_claim";
		sourceId: string;
		text: string;
	}> = [
		...commonEvents.map((e) => ({
			kind: "world_event" as const,
			sourceId: e.id,
			text: e.summary,
		})),
		...common(first.facts, (v) => v.facts).map((f) => ({
			kind: "world_fact" as const,
			sourceId: f.id,
			text: f.text,
		})),
		...common(first.claims, (v) => v.claims).map((c) => ({
			kind: "life_claim" as const,
			sourceId: c.id,
			text: c.text,
		})),
	];
	const body = {
		version: 1 as const,
		worldId: life.worldId,
		authorAgentId: input.authorAgentId,
		source: {
			kind: "event" as const,
			intentId: intent.id,
			eventId: event.id,
			worldRevision: event.revision,
			lifeRevision: life.revision,
		},
		definitionRevision: input.definitionRevision,
		policyRevision: input.policy.revision,
		workRevision: input.workRevision,
		workAncestryRevision: input.workAncestryRevision,
		limits: { ...input.limits },
		configRevision: input.configRevision,
		settingsRevision: input.settingsRevision,
		workEvidenceDigest: input.workEvidenceDigest,
		audience,
		allowedClaims: statements.map((statement) => ({
			...statement,
			id: `claim-${lifeDigest({ kind: statement.kind, id: statement.sourceId })}`,
		})),
		permittedScene: views.every(
			(view) => lifeDigest(view.scene) === lifeDigest(first.scene),
		)
			? first.scene
			: null,
	};
	const identified = { ...body, id: `material-${lifeDigest(body)}` };
	return { ...identified, digest: lifeDigest(identified) };
}

/** Explicit public projection. Internal source IDs, proof revisions and audience never reach narration. */
export function publicationNarrationMaterial(material: PublicationMaterial) {
	return {
		claims: material.allowedClaims.map((claim) => ({
			id: claim.id,
			kind: claim.kind,
			text: claim.text,
		})),
		scene: material.permittedScene
			? {
					place: material.permittedScene.place.name,
					environment: material.permittedScene.place.description,
					description: material.permittedScene.description,
				}
			: null,
	};
}
