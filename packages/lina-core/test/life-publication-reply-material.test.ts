import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	type PublicationReplyMaterialInput,
	selectPublicationReplyMaterial,
} from "../src/world/publication-reply-material.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

function input(): PublicationReplyMaterialInput {
	const store = publicationStoreFixture();
	try {
		const material = store.publicationMaterial(
			"test-world",
			"intent",
			"lina",
			["friends"],
			{ maxChars: 20000, maxRecords: 100 },
		);
		const settings = store.publicationSettings("test-world");
		if (material?.version !== 1 || !settings)
			throw Error("Missing event material");
		const claim = material.allowedClaims[0];
		if (!claim) throw Error("Missing visible claim");
		return {
			world: store.snapshot("test-world"),
			life: store.lifeSnapshot("test-world"),
			definition: store.lifeDefinition("test-world"),
			config: store.lifeConfig("test-world"),
			settings,
			activeAgents: ["lina", "mira"],
			agentId: "lina",
			recipientId: "friends",
			work: store.workEvidence("test-world"),
			workAncestryRevision: 0,
			limits: { maxChars: 20000, maxRecords: 100 },
			parent: {
				owner: "post",
				audience: ["friends"],
				origin: material.source,
				roots: [
					{
						rootId: `chain-${lifeDigest({ worldId: "test-world", eventId: material.source.eventId })}`,
						depth: 0,
					},
				],
				authority: {
					settingsRevision: settings.revision,
					posts: [{ kind: "post", id: "parent-post", revision: 1 }],
					grants: [],
				},
				post: {
					id: "parent-post",
					revision: 1,
					kind: "post",
					author: { kind: "agent", agentId: "mira", name: "Mira" },
					createdAt: 1000,
					segments: [
						{ kind: "claim", claimKind: claim.kind, text: claim.text },
						{ kind: "imaginative", text: "Maybe tomorrow will be quieter." },
					],
				},
				claims: [{ segmentIndex: 0, claim }],
			},
		};
	} finally {
		store.close();
	}
}

test("reply material copies only visible supported parent claims and typed public text", () => {
	const source = input();
	const before = lifeDigest(source);
	const material = selectPublicationReplyMaterial(source);
	expect(material?.version).toBe(2);
	expect(material?.allowedClaims).toEqual(
		source.parent.claims.map((binding) => binding.claim),
	);
	expect(material?.parent).toEqual(source.parent.post);
	expect(material?.source.origin).toEqual(source.parent.origin);
	expect(material?.permittedScene).toBeNull();
	expect(JSON.stringify(material)).not.toContain("hidden key");
	expect(lifeDigest(source)).toBe(before);
});

test("user text and imagination cannot acquire a supported claim binding", () => {
	const source = input();
	source.parent.post = {
		...source.parent.post,
		kind: "reply",
		author: { kind: "viewer" },
		parentPostId: "origin",
		segments: [{ kind: "user_authored", text: "I know a secret" }],
	};
	source.parent.owner = "reply";
	source.parent.authority.posts = [
		{ id: source.parent.post.id, kind: "reply", revision: 1 },
		{ id: "origin", kind: "post", revision: 1 },
	];
	source.parent.claims = [];
	expect(selectPublicationReplyMaterial(source)?.allowedClaims).toEqual([]);
	const forged = input().parent.claims[0];
	if (!forged) throw Error("Missing claim");
	source.parent.claims = [forged];
	expect(() => selectPublicationReplyMaterial(source)).toThrow();
});

test("reply admission requires explicit mapping, active author, parent audience and matching source snapshots", () => {
	for (const kind of ["mapping", "inactive", "audience", "self"] as const) {
		const source = input();
		if (kind === "mapping") source.settings.agentRecipients = [];
		if (kind === "inactive") source.activeAgents = [];
		if (kind === "audience") source.parent.audience = [];
		if (kind === "self")
			source.parent.post.author = {
				kind: "agent",
				agentId: "lina",
				name: "Lina",
			};
		expect(selectPublicationReplyMaterial(source)).toBeNull();
	}
	const source = input();
	source.world.revision++;
	expect(() => selectPublicationReplyMaterial(source)).toThrow();
});
