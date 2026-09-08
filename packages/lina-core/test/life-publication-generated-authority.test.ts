import { expect, test } from "bun:test";
import {
	type Access,
	PublicationEvidence,
} from "../src/world/publication-evidence.ts";
import { publicationObservationId } from "../src/world/publication-input.ts";
import { autonomySource } from "./life-autonomy-pure-fixture.ts";

test("generated ancestor grants join frozen authority and later revocation invalidates current evidence", () => {
	const worldId = "test-world",
		inputId = publicationObservationId(
			worldId,
			"generated-interaction",
			"mira",
		);
	let grantRevision = 1;
	const access: Access = {
		observations: () => ({
			revision: 1,
			records: [
				{
					inputId,
					source: {
						kind: "publication_interaction",
						observationId: inputId,
						interactionId: "generated-interaction",
						postId: "generated",
						postRevision: 1,
						principal: { kind: "agent", agentId: "lina" },
						recipientAgentId: "mira",
						action: { kind: "reply", text: "A synthetic typed-owner boundary" },
						roots: [{ rootId: "chain", depth: 2 }],
					},
				},
			],
		}),
		settingsRevision: () => 1,
		post: (_world, id) => ({
			id,
			kind: "post",
			revision: 1,
			parentId: id === "generated" ? "root" : null,
			...(id === "generated" ? { grantIds: ["original-viewer"] } : {}),
		}),
		grant: (_world, id, at) => ({ id, revision: at ?? grantRevision }),
		view: (_source, authority) => ({
			visible: () => authority.grants.every((grant) => grant.revision === 1),
		}),
	};
	const evidence = new PublicationEvidence(access),
		source = autonomySource(),
		snapshot = evidence.freeze(source);
	expect(snapshot.authority.grants).toEqual([
		{ id: "original-viewer", revision: 1 },
	]);
	expect(snapshot.authority.posts.map((post) => post.id)).toEqual([
		"generated",
		"root",
	]);
	grantRevision = 2;
	expect(() => evidence.assertCurrent(source, snapshot)).toThrow();
	expect(() => evidence.verify(source, snapshot)).not.toThrow();
	expect(evidence.freeze(source).records).toEqual([]);
	const altered = structuredClone(snapshot);
	altered.authority.grants = [];
	expect(() => evidence.verify(source, altered)).toThrow();
});
