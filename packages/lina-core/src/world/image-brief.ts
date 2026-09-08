import type { FrozenVisualIdentity, VisualPurpose } from "../agents/visual.ts";
import {
	parseFrozenVisualIdentity,
	parseVisualPurpose,
} from "../agents/visual-validation.ts";
import type {
	LifeImageMaterial,
	PublishedImageMaterial,
} from "./image-types.ts";
import { array, jsonBoundary, keyed, lifeDigest } from "./life-json.ts";

/** Publication is rebuilt by WorldStore; visual grants are supplied and verified by AgentStore. */
export function freezeLifeImageMaterial(input: {
	purpose: VisualPurpose;
	publication: PublishedImageMaterial | null;
	visuals: FrozenVisualIdentity[];
}): LifeImageMaterial {
	jsonBoundary(input);
	const purpose = parseVisualPurpose(input.purpose);
	const visuals = keyed(
		array(input.visuals, parseFrozenVisualIdentity),
		(value) => value.agentId,
	);
	const publication = structuredClone(input.publication);
	if (!visuals.length)
		throw Error("Image brief requires approved visual identity");
	if (purpose.kind === "avatar") {
		if (publication !== null || visuals.length !== 1)
			throw Error("Avatar brief requires one subject and no event text");
	} else if (
		!publication ||
		publication.worldId !== purpose.worldId ||
		publication.source.recipientId !== purpose.recipientId ||
		!visuals.some((value) => value.agentId === publication.authorAgentId)
	) {
		throw Error("Image publication purpose mismatch");
	}
	for (const visual of visuals) {
		if (!visual.reference && !visual.textIdentity)
			throw Error("Image identity is not explicitly approved");
		if (
			!visual.grants.length ||
			visual.grants.some(
				(grant) => lifeDigest(grant.purpose) !== lifeDigest(purpose),
			)
		)
			throw Error("Image reference purpose is not approved");
		if (
			publication &&
			visual.agentId !== publication.authorAgentId &&
			!publication.scene?.occupants.includes(visual.agentId)
		)
			throw Error("Image subject is absent from the permitted scene");
	}
	if (visuals.filter((value) => value.reference !== null).length > 1)
		throw Error(
			"unsupported_image_references: the current provider accepts one reference",
		);
	const subjects = visuals.map((value) => ({
		agentId: value.agentId,
		anchors: value.anchors,
		identity: value.textIdentity,
		reference: value.reference
			? { sha256: value.reference.sha256, mime: value.reference.mime }
			: null,
	}));
	const scene = publication?.scene
		? {
				place: publication.scene.place.name,
				environment: publication.scene.place.description,
				description: publication.scene.description,
			}
		: null;
	const claims = publication?.claims ?? [];
	const prompt = JSON.stringify({
		instruction:
			purpose.kind === "avatar"
				? "Create an agent portrait from this approved visual identity."
				: "Illustrate this fictional scene using only the supplied permitted facts and approved visual identities.",
		subjects: subjects.map(({ reference: _reference, ...subject }) => subject),
		scene,
		claims,
	});
	const body = {
		version: 1 as const,
		purpose,
		publication,
		visuals,
		prompt,
		altText: publication
			? (publication.claims[0]?.text ??
				publication.scene?.description ??
				"Fictional scene")
			: "Agent portrait",
		fingerprint: lifeDigest({ purpose, subjects, scene, claims }),
	};
	return { ...body, digest: lifeDigest(body) };
}
