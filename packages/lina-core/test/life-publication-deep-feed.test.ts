import { expect, test } from "bun:test";
import { PublicationFeed } from "../src/world/publication-feed.ts";
import type { PublicationPost } from "../src/world/publication-types.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";

test("reading a deep explicit reshare history does not exhaust the call stack and still rechecks the original audience", () => {
	const f = preparedPublicationFixture(":memory:");
	try {
		if (!f.job.material) throw Error("fixture material absent");
		const root: PublicationPost = {
			version: 1,
			worldId: "test-world",
			id: "root-post",
			revision: 1,
			jobId: f.job.id,
			attemptId: f.job.attemptId,
			material: f.job.material,
			author: publicationAuthor,
			roots: [{ rootId: "chain", depth: 0 }],
			segments: [{ kind: "imaginative", text: "A shared moment" }],
			createdAt: 1000,
			createdLifeRevision: 1,
			withdrawn: false,
		};
		const feed = new PublicationFeed(
			{
				get: (_world, id) => (id === root.id ? root : null),
				list: () => [root],
			},
			{
				get: () => {
					throw Error("Agent fixture never uses a viewer grant");
				},
			},
			{
				recipients: () => ({
					revision: 1,
					recipientIds: ["friends"],
					agents: [{ agentId: "lina", recipientId: "friends" }],
				}),
				material: () => root.material,
			},
			{
				posts: {
					list: () => [],
					get: (_world, id) => {
						const n = Number(id.slice(1));
						return {
							version: 1,
							worldId: "test-world",
							id,
							revision: 1,
							interactionId: `i${n}`,
							parentPostId: n === 1 ? root.id : `p${n - 1}`,
							principal: { kind: "viewer", grantId: "hidden" },
							audience: ["friends"],
							roots: [{ rootId: "chain", depth: n }],
							createdAt: 1000,
							createdLifeRevision: 1,
							withdrawn: false,
						};
					},
				},
				interactions: {
					get: (_world, id) => ({
						version: 1,
						worldId: "test-world",
						id,
						requestKey: id,
						principal: { kind: "viewer", grantId: "hidden" },
						parentPostId: "root-post",
						expectedPostRevision: 1,
						action: { kind: "reshare" },
						roots: [{ rootId: "chain", depth: 1 }],
						audience: ["friends"],
						createdAt: 1000,
						lifeRevision: 1,
						settingsRevision: 1,
						postId: `p${id.slice(1)}`,
						processing: "stopped",
						observationIds: [],
					}),
				},
			},
		);
		const principal = { kind: "agent" as const, agentId: "lina" };
		expect(feed.post(root.worldId, principal, "p100000")?.segments).toEqual(
			root.segments,
		);
		root.withdrawn = true;
		expect(feed.post(root.worldId, principal, "p100000")).toBeNull();
	} finally {
		f.store.close();
	}
});
