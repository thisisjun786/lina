import { expect, test } from "bun:test";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { freezeLifeImageMaterial } from "../src/world/image-brief.ts";
import { discoverEventImageCandidates } from "../src/world/image-discovery.ts";
import { imageIntentId } from "../src/world/image-intents.ts";
import { publishedImageMaterial } from "../src/world/image-material.ts";
import type {
	LifeImageIntent,
	LifeImageSettings,
	PublishedImageMaterial,
} from "../src/world/image-types.ts";
import type { EventPublicationPost } from "../src/world/publication-types.ts";
import { pureStep } from "./life-autonomy-pure-fixture.ts";
import { identityPolicy } from "./life-fixture.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";

const storage = {
	maxActiveJobs: 4,
	maxArchivedJobs: 10,
	maxAssets: 10,
	maxTotalBytes: 10_000_000,
};

function visual(agentId: string, recipientId: string): FrozenVisualIdentity {
	return {
		agentId,
		profileRevision: 1,
		visualRevision: 1,
		avatarPolicyRevision: 1,
		anchors: ["blue hair"],
		textIdentity: "Approved portrait",
		reference: null,
		grants: [
			{
				grantId: `grant-${agentId}`,
				revision: 1,
				purpose: {
					kind: "life",
					worldId: "test-world",
					recipientId,
				},
			},
		],
	};
}

function settings(
	eventRules: LifeImageSettings["eventRules"],
	perAuthorCooldownSteps = 0,
): LifeImageSettings {
	return {
		version: 1,
		worldId: "test-world",
		revision: 1,
		worldVersion: 1,
		route: { provider: "synthetic", model: "image" },
		eventRules,
		avatarEventRules: [],
		perAuthorCooldownSteps,
		attachMode: "automatic",
		maxJobsPerVisit: 2,
		storage,
	};
}

function meetRule(
	options: {
		trigger?: "event" | "scene_change";
		composition?: "single_subject" | "all_scene_subjects";
		agentIds?: string[];
	} = {},
): LifeImageSettings["eventRules"][number] {
	return {
		familyId: "meet",
		agentIds: options.agentIds ?? ["lina"],
		trigger: options.trigger ?? "event",
		composition: options.composition ?? "single_subject",
	};
}

function acceptedFamilyStep(
	post: EventPublicationPost,
	options: {
		agentId?: string | null;
		familyId?: string | null;
		status?: LifeStep["status"];
		eventId?: string;
		kind?: "quiet" | "event";
		lifeRevision?: number;
	} = {},
): LifeStep {
	const step = pureStep();
	const source = post.material.source;
	return {
		...step,
		worldId: post.worldId,
		status: options.status ?? "accepted",
		decision: {
			...step.decision,
			kind: options.kind ?? "event",
			familyId: options.familyId === undefined ? "meet" : options.familyId,
			agentId:
				options.agentId === undefined ? post.author.agentId : options.agentId,
		},
		receipt: {
			worldId: post.worldId,
			eventId: options.eventId ?? source.eventId,
			worldRevision: source.worldRevision,
			lifeRevision: options.lifeRevision ?? source.lifeRevision,
			inputDigest: "a".repeat(64),
			replayed: false,
			identity: identityPolicy(),
		},
	};
}

function eventIntent(
	publication: PublishedImageMaterial,
	options: {
		agentId?: string;
		createdLifeRevision?: number;
		publicationId?: string;
	} = {},
): LifeImageIntent {
	const agentId = options.agentId ?? publication.authorAgentId;
	const source = {
		...publication.source,
		publicationId: options.publicationId ?? publication.source.publicationId,
	};
	const material = freezeLifeImageMaterial({
		purpose: {
			kind: "life",
			worldId: publication.worldId,
			recipientId: publication.source.recipientId,
		},
		publication: { ...publication, authorAgentId: agentId },
		visuals: [visual(agentId, publication.source.recipientId)],
	});
	const requestKey = null;
	return {
		version: 2,
		intentId: imageIntentId({
			worldId: publication.worldId,
			agentId,
			source,
			requestKey,
		}),
		owner: { kind: "life", worldId: publication.worldId, agentId },
		source,
		material,
		settingsRevision: 1,
		configRevision: 1,
		createdAtMs: 1000,
		createdLifeRevision: options.createdLifeRevision ?? 0,
		requestKey,
		briefDigest: material.digest,
	};
}

function withPublished(
	run: (
		post: EventPublicationPost,
		materials: Array<{
			recipientId: string;
			material: PublishedImageMaterial;
		}>,
	) => void,
	options?: {
		imaginativeOnly?: boolean;
		eventText?: string;
		allowScene?: boolean;
	},
): void {
	const f = publishedImageFixture(
		options?.imaginativeOnly ?? false,
		options?.eventText ?? "Residents met at the cafe.",
		options?.allowScene ?? true,
	);
	try {
		const row = f.store.imageDiscoveryPosts("test-world")[0];
		if (!row) throw Error("Missing published event post");
		run(row.post, row.materials);
	} finally {
		f.store.close();
	}
}

function readyIntentId(
	post: EventPublicationPost,
	material: PublishedImageMaterial,
): string {
	return imageIntentId({
		worldId: material.worldId,
		agentId: post.author.agentId,
		source: material.source,
		requestKey: null,
	});
}

test("missing settings stay not_configured and empty event rules hold without reading posts", () => {
	withPublished((post, materials) => {
		expect(
			discoverEventImageCandidates({
				settings: null,
				posts: [{ post, materials }],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [],
			}),
		).toEqual({ status: "not_configured", candidates: [], skips: [] });
		expect(
			discoverEventImageCandidates({
				settings: settings([]),
				posts: [{ post, materials }],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [],
			}),
		).toEqual({ status: "hold", candidates: [], skips: [] });
	});
});

test("family comes from the accepted receipt, never from event prose or an unaccepted step", () => {
	withPublished((post, materials) => {
		expect(post.segments.some((segment) => segment.kind === "claim")).toBe(
			true,
		);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()]),
				posts: [{ post, materials }],
				acceptedSteps: [],
				existingIntents: [],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "unchanged",
				postId: post.id,
				agentId: "lina",
				reason: "no_accepted_family_receipt",
			},
		]);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()]),
				posts: [{ post, materials }],
				acceptedSteps: [
					acceptedFamilyStep(post, { status: "ready" }),
					acceptedFamilyStep(post, {
						kind: "quiet",
						familyId: null,
						agentId: null,
					}),
					acceptedFamilyStep(post, { eventId: "other-event" }),
				],
				existingIntents: [],
			}).candidates,
		).toEqual([]);
		const otherFamily = discoverEventImageCandidates({
			settings: settings([meetRule()]),
			posts: [{ post, materials }],
			acceptedSteps: [acceptedFamilyStep(post, { familyId: "other" })],
			existingIntents: [],
		});
		expect(otherFamily).toEqual({
			status: "quiet",
			candidates: [],
			skips: [],
		});
	});
});

test("accepted family receipt with a configured author rule selects the published material", () => {
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material) throw Error("Missing permitted recipient material");
		const found = discoverEventImageCandidates({
			settings: settings([meetRule()]),
			posts: [{ post, materials }],
			acceptedSteps: [acceptedFamilyStep(post)],
			existingIntents: [],
		});
		expect(found.status).toBe("ready");
		expect(found.skips).toEqual([]);
		expect(found.candidates).toEqual([
			{
				kind: "event_post",
				status: "ready",
				agentId: "lina",
				source: material.source,
				publication: material,
				visualAgentIds: ["lina"],
				intentId: readyIntentId(post, material),
				reason: "configured_published_material",
			},
		]);
	});
});

test("a shared-event post can use the accepted family even when another participant authored it", () => {
	withPublished((post, materials) => {
		const original = materials[0]?.material;
		if (!original) throw Error("Missing permitted recipient material");
		const miraPost: EventPublicationPost = {
			...post,
			author: { ...post.author, agentId: "mira", name: "Mira" },
			material: { ...post.material, authorAgentId: "mira" },
		};
		const miraMaterial = publishedImageMaterial(miraPost, "friends");
		if (!miraMaterial) throw Error("Missing Mira publication material");
		const found = discoverEventImageCandidates({
			settings: settings([meetRule({ agentIds: ["mira"] })]),
			posts: [
				{
					post: miraPost,
					materials: [{ recipientId: "friends", material: miraMaterial }],
				},
			],
			acceptedSteps: [acceptedFamilyStep(post, { agentId: "lina" })],
			existingIntents: [],
		});
		expect(found.candidates).toEqual([
			{
				kind: "event_post",
				status: "ready",
				agentId: "mira",
				source: miraMaterial.source,
				publication: miraMaterial,
				visualAgentIds: ["mira"],
				intentId: readyIntentId(miraPost, miraMaterial),
				reason: "configured_published_material",
			},
		]);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule({ agentIds: ["lina"] })]),
				posts: [
					{
						post: miraPost,
						materials: [{ recipientId: "friends", material: miraMaterial }],
					},
				],
				acceptedSteps: [acceptedFamilyStep(post, { agentId: "lina" })],
				existingIntents: [],
			}),
		).toEqual({ status: "quiet", candidates: [], skips: [] });
	});
});

test("missing recipient and text-only published material are skipped without inventing a scene", () => {
	withPublished(
		(post) => {
			expect(
				discoverEventImageCandidates({
					settings: settings([meetRule()]),
					posts: [{ post, materials: [] }],
					acceptedSteps: [acceptedFamilyStep(post)],
					existingIntents: [],
				}).skips,
			).toEqual([
				{
					kind: "event_post",
					status: "text_only",
					postId: post.id,
					agentId: "lina",
					reason: "no_currently_permitted_recipient",
				},
			]);
		},
		{ imaginativeOnly: true, allowScene: false },
	);
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material) throw Error("Missing permitted recipient material");
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()]),
				posts: [
					{
						post,
						materials: [
							{
								recipientId: "friends",
								material: { ...material, claims: [], scene: null },
							},
						],
					},
				],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "text_only",
				postId: post.id,
				agentId: "lina",
				reason: "no_permitted_image_material",
			},
		]);
	});
});

test("an existing original-post intent is unchanged and a later cooldown boundary is inclusive", () => {
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material) throw Error("Missing permitted recipient material");
		const later: PublishedImageMaterial = {
			...material,
			source: {
				...material.source,
				lifeRevision: 4,
				publicationId: "later-post",
			},
		};
		const laterPost: EventPublicationPost = {
			...post,
			id: "later-post",
			material: {
				...post.material,
				source: { ...post.material.source, lifeRevision: 4 },
			},
		};
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()]),
				posts: [{ post, materials }],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [eventIntent(material)],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "unchanged",
				postId: post.id,
				agentId: "lina",
				reason: "original_post_intent_exists",
			},
		]);
		const laterMaterials = [{ recipientId: "friends", material: later }];
		const laterStep = acceptedFamilyStep(laterPost, { lifeRevision: 4 });
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()], 2),
				posts: [{ post: laterPost, materials: laterMaterials }],
				acceptedSteps: [laterStep],
				existingIntents: [
					eventIntent(material, {
						createdLifeRevision: 2,
						publicationId: "prior-post",
					}),
				],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "cooldown",
				postId: "later-post",
				agentId: "lina",
				reason: "per_author_cooldown_steps",
			},
		]);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()], 1),
				posts: [{ post: laterPost, materials: laterMaterials }],
				acceptedSteps: [laterStep],
				existingIntents: [
					eventIntent(material, {
						createdLifeRevision: 2,
						publicationId: "prior-post",
					}),
				],
			}).candidates,
		).toHaveLength(1);
	});
});

test("scene_change skips an unchanged fingerprint and rediscovers a different scene", () => {
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material) throw Error("Missing permitted recipient material");
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule({ trigger: "scene_change" })]),
				posts: [{ post, materials }],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [
					eventIntent(material, { publicationId: "prior-post" }),
				],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "unchanged",
				postId: post.id,
				agentId: "lina",
				reason: "scene_fingerprint_unchanged",
			},
		]);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule()]),
				posts: [{ post, materials }],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [
					eventIntent(material, { publicationId: "prior-post" }),
				],
			}).candidates,
		).toHaveLength(1);
	});
	const garden = publishedImageFixture(
		false,
		"They walked in the garden.",
		true,
	);
	try {
		withPublished((post, materials) => {
			const material = materials[0]?.material;
			const prior =
				garden.store.imageDiscoveryPosts("test-world")[0]?.materials[0]
					?.material;
			if (!material || !prior)
				throw Error("Missing scene fingerprint publications");
			expect(prior.fingerprint).not.toBe(material.fingerprint);
			expect(
				discoverEventImageCandidates({
					settings: settings([meetRule({ trigger: "scene_change" })]),
					posts: [{ post, materials }],
					acceptedSteps: [acceptedFamilyStep(post)],
					existingIntents: [
						eventIntent(prior, { publicationId: "prior-garden-post" }),
					],
				}).candidates,
			).toHaveLength(1);
		});
	} finally {
		garden.store.close();
	}
});

test("all_scene_subjects returns every authorized occupant and does not silently truncate", () => {
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material?.scene) throw Error("Missing permitted scene occupants");
		expect([...material.scene.occupants].sort()).toEqual(["lina", "mira"]);
		const found = discoverEventImageCandidates({
			settings: settings([meetRule({ composition: "all_scene_subjects" })]),
			posts: [{ post, materials }],
			acceptedSteps: [acceptedFamilyStep(post)],
			existingIntents: [],
		});
		expect(found.candidates[0]?.visualAgentIds).toEqual(["lina", "mira"]);
		const duplicated: PublishedImageMaterial = {
			...material,
			scene: {
				...material.scene,
				occupants: ["mira", "lina", "mira"],
			},
		};
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule({ composition: "all_scene_subjects" })]),
				posts: [
					{
						post,
						materials: [{ recipientId: "friends", material: duplicated }],
					},
				],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [],
			}).candidates[0]?.visualAgentIds,
		).toEqual(["lina", "mira"]);
		expect(
			discoverEventImageCandidates({
				settings: settings([meetRule({ composition: "all_scene_subjects" })]),
				posts: [
					{
						post,
						materials: [
							{
								recipientId: "friends",
								material: {
									...material,
									scene: { ...material.scene, occupants: [] },
								},
							},
						],
					},
				],
				acceptedSteps: [acceptedFamilyStep(post)],
				existingIntents: [],
			}).skips,
		).toEqual([
			{
				kind: "event_post",
				status: "text_only",
				postId: post.id,
				agentId: "lina",
				reason: "no_permitted_scene_occupants",
			},
		]);
	});
});

test("unrelated agent event intents do not cooldown or occupy another author's post", () => {
	withPublished((post, materials) => {
		const material = materials[0]?.material;
		if (!material) throw Error("Missing permitted recipient material");
		const found = discoverEventImageCandidates({
			settings: settings([meetRule()], 8),
			posts: [{ post, materials }],
			acceptedSteps: [acceptedFamilyStep(post)],
			existingIntents: [
				eventIntent(material, {
					agentId: "mira",
					createdLifeRevision: 1,
					publicationId: "mira-other-post",
				}),
			],
		});
		expect(found.candidates).toHaveLength(1);
		expect(found.candidates[0]?.agentId).toBe("lina");
		expect(found.skips).toEqual([]);
	});
});
