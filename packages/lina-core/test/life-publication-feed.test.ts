import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PublicationGrants } from "../src/world/publication-grants.ts";
import { PublicationJobs } from "../src/world/publication-jobs.ts";
import { PublicationPosts } from "../src/world/publication-posts.ts";
import { PublicationReplyPosts } from "../src/world/publication-reply-posts.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";

function narrated(path: string) {
	const f = preparedPublicationFixture(path),
		claimId = f.job.material?.allowedClaims[0]?.id;
	if (!claimId) throw Error("Missing public claim");
	f.store.dispatchPublicationModel(
		f.lease,
		f.run.id,
		f.job.id,
		f.prepared.request.id,
	);
	f.store.finishPublicationModel(
		f.job.worldId,
		f.job.id,
		f.prepared.request.id,
		{
			status: "completed",
			result: {
				version: 1,
				requestId: f.prepared.request.id,
				inputDigest: f.prepared.inputDigest,
				capabilityFingerprint: f.prepared.capabilityFingerprint,
				nativeReference: f.prepared.nativeReference,
				provider: "synthetic",
				model: "narrator",
				threadId: "synthetic-thread",
				turnId: "synthetic-turn",
				text: JSON.stringify({
					kind: "post",
					segments: [
						{ kind: "claim", claimId },
						{ kind: "imaginative", text: "Perhaps tomorrow will be quieter." },
					],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		},
	);
	return f;
}

test("historical post and grant revisions remain exact after withdrawal and revocation without becoming feed authority", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-history-")),
		path = join(root, "world.sqlite");
	const f = narrated(path);
	let db: DatabaseSync | undefined;
	try {
		const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		if (!job.postId) throw Error("fixture post absent");
		const { grant } = f.store.mintPublicationViewer("test-world", {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: grant.id };
		const reply = f.store.replyToPublication(
			"test-world",
			principal,
			job.postId,
			{
				requestKey: "reply",
				expectedPostRevision: 1,
				text: "History stays historical",
			},
		);
		const interaction = reply.interaction;
		if (!reply.postId || !interaction) throw Error("fixture reply absent");
		f.store.withdrawPublicationPost("test-world", reply.postId, {
			requestKey: "withdraw-reply",
			expectedRevision: 1,
		});
		f.store.withdrawPublicationPost("test-world", job.postId, {
			requestKey: "withdraw-post",
			expectedRevision: 1,
		});
		f.store.revokePublicationViewer("test-world", grant.id, {
			requestKey: "revoke",
			expectedRevision: 1,
		});
		f.store.close();
		db = new DatabaseSync(path);
		const posts = new PublicationPosts(db, new PublicationJobs(db)),
			replies = new PublicationReplyPosts(db, {
				interaction: () => interaction,
			}),
			grants = new PublicationGrants(db, () => ({
				settingsRevision: 1,
				recipientIds: ["friends"],
			}));
		expect(posts.at("test-world", job.postId, 1)?.withdrawn).toBe(false);
		expect(posts.at("test-world", job.postId, 2)?.withdrawn).toBe(true);
		expect(replies.at("test-world", reply.postId, 1)?.withdrawn).toBe(false);
		expect(replies.at("test-world", reply.postId, 2)?.withdrawn).toBe(true);
		expect(grants.at("test-world", grant.id, 1)).toEqual(grant);
		expect(grants.at("test-world", grant.id, 2).revoked).toBe(true);
		for (const rev of [0, 3, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => posts.at("test-world", job.postId ?? "", rev)).toThrow();
			expect(() => replies.at("test-world", reply.postId ?? "", rev)).toThrow();
			expect(() => grants.at("test-world", grant.id, rev)).toThrow();
		}
	} finally {
		db?.close();
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["post", "observation"] as const)(
	"reopen requires the complete interaction %s graph",
	(part) => {
		const root = mkdtempSync(
				join(tmpdir(), "lina-publication-interaction-graph-"),
			),
			path = join(root, "world.sqlite");
		const f = narrated(path);
		try {
			const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			});
			if (!job.postId) throw Error("fixture post absent");
			const { grant } = f.store.mintPublicationViewer("test-world", {
				requestKey: "viewer",
				expectedSettingsRevision: 1,
				recipientId: "friends",
			});
			f.store.replyToPublication(
				"test-world",
				{ kind: "viewer", grantId: grant.id },
				job.postId,
				{
					requestKey: "reply",
					expectedPostRevision: 1,
					text: "An enduring reply",
				},
			);
			f.store.close();
			const db = new DatabaseSync(path);
			try {
				if (part === "post") {
					for (const table of [
						"life_publication_reply_post_requests",
						"life_publication_reply_post_receipts",
						"life_publication_reply_posts",
						"life_publication_reply_post_history",
					])
						db.exec(`DELETE FROM ${table}`);
				} else {
					for (const table of [
						"life_publication_reply_post_requests",
						"life_publication_reply_post_receipts",
						"life_publication_reply_posts",
						"life_publication_reply_post_history",
						"life_publication_observations",
						"life_publication_reaction_heads",
						"life_publication_interactions",
						"life_publication_interaction_receipts",
						"life_publication_interaction_state",
					])
						db.exec(`DELETE FROM ${table}`);
				}
			} finally {
				db.close();
			}
			expect(() => new WorldStore(path)).toThrow("publication interaction");
		} finally {
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("reply, reaction and reshare survive WorldStore reopen with one observation per effective action and no world mutation", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-feedback-store-")),
		path = join(root, "world.sqlite");
	const f = narrated(path);
	let reopened: WorldStore | undefined;
	try {
		const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		if (!job.postId) throw Error("fixture post absent");
		const settings = f.store.publicationSettings("test-world");
		if (!settings) throw Error("fixture settings absent");
		const { worldId, revision, ...value } = settings;
		f.store.setPublicationSettings(worldId, revision, {
			...value,
			reactionIds: ["support"],
		});
		const { grant } = f.store.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 2,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: grant.id };
		const before = f.store.lifeSnapshot(worldId);
		const request = {
			requestKey: "reply",
			expectedPostRevision: 1,
			text: "Thanks for sharing that moment.",
		};
		const reply = f.store.replyToPublication(
			worldId,
			principal,
			job.postId,
			request,
		);
		expect(reply.effective).toBe(true);
		expect(
			f.store.replyToPublication(worldId, principal, job.postId, request),
		).toMatchObject({ postId: reply.postId, replayed: true, effective: true });
		const reaction = {
			requestKey: "react",
			expectedPostRevision: 1,
			reactionId: "support",
			active: true,
		};
		expect(
			f.store.reactToPublication(worldId, principal, job.postId, reaction)
				.effective,
		).toBe(true);
		expect(
			f.store.reactToPublication(worldId, principal, job.postId, {
				...reaction,
				requestKey: "equal-state",
			}).effective,
		).toBe(false);
		const reshare = f.store.resharePublication(worldId, principal, job.postId, {
			requestKey: "share",
			expectedPostRevision: 1,
		});
		expect(reshare.effective).toBe(true);
		expect(f.store.lifeInputs(worldId)).toHaveLength(3);
		expect(f.store.lifeSnapshot(worldId)).toEqual(before);
		const feed = f.store.publicationFeed(worldId, principal, {
			limit: 100,
			after: null,
		});
		expect(feed.items).toHaveLength(3);
		expect(feed.items.find((post) => post.id === reply.postId)).toMatchObject({
			kind: "reply",
			parentPostId: job.postId,
			author: { kind: "viewer" },
			segments: [{ kind: "user_authored", text: request.text }],
		});
		expect(JSON.stringify(feed)).not.toContain(grant.id);
		if (!reply.postId) throw Error("fixture reply absent");
		f.store.setPublicationReadCursor(worldId, principal, {
			expectedRevision: 0,
			postId: reply.postId,
		});
		f.store.close();
		reopened = new WorldStore(path, () => 1000);
		expect(
			reopened.publicationFeed(worldId, principal, { limit: 100, after: null }),
		).toEqual(feed);
		expect(reopened.publicationReadCursor(worldId, principal).postId).toBe(
			reply.postId,
		);
		expect(
			reopened.replyToPublication(worldId, principal, job.postId, request)
				.replayed,
		).toBe(true);
		expect(reopened.lifeInputs(worldId)).toHaveLength(3);
		reopened.withdrawPublicationPost(worldId, job.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			reopened.publicationFeed(worldId, principal, { limit: 100, after: null })
				.items,
		).toEqual([]);
		expect(
			reopened.publicationReadCursor(worldId, principal).postId,
		).toBeNull();
	} finally {
		reopened?.close();
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("exhausted chains retain explicit user replies but admit no recursive observation", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-stopped-store-")),
		path = join(root, "world.sqlite");
	const f = narrated(path);
	try {
		const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		if (!job.postId) throw Error("fixture post absent");
		const settings = f.store.publicationSettings("test-world");
		if (!settings) throw Error("fixture settings absent");
		const { worldId, revision, ...value } = settings;
		f.store.setPublicationSettings(worldId, revision, {
			...value,
			maxActionsPerChain: 1,
		});
		const { grant } = f.store.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 2,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: grant.id };
		const reply = f.store.replyToPublication(worldId, principal, job.postId, {
			requestKey: "reply",
			expectedPostRevision: 1,
			text: "Still visible",
		});
		expect(reply.interaction?.processing).toBe("stopped");
		expect(f.store.lifeInputs(worldId)).toEqual([]);
		expect(
			f.store.publicationFeed(worldId, principal, { limit: 100, after: null })
				.items,
		).toHaveLength(2);
	} finally {
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("publish once, read only the bearer audience and retain withdrawal tombstones across real reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-feed-")),
		path = join(root, "world.sqlite"),
		f = narrated(path);
	try {
		const published = f.store.completePublicationJob(
			f.lease,
			f.run.id,
			f.job.id,
			{ author: publicationAuthor, modelSettingsRevision: 1 },
		);
		expect(published.status).toBe("published");
		expect(published.postId).not.toBeNull();
		expect(
			f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			}),
		).toEqual(published);
		const issued = f.store.mintPublicationViewer("test-world", {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: issued.grant.id };
		const feed = f.store.publicationFeed("test-world", principal, {
			limit: 100,
			after: null,
		});
		expect(feed.items).toHaveLength(1);
		expect(feed.items[0]?.segments).toEqual([
			{
				kind: "claim",
				claimKind: "world_event",
				text: "A bell rang during the meeting",
			},
			{ kind: "imaginative", text: "Perhaps tomorrow will be quieter." },
		]);
		const wire = JSON.stringify(feed);
		for (const hidden of [
			"payloadDigest",
			"workRevision",
			"materialId",
			"intentId",
			"recipientId",
			"nativeReference",
			"knowers",
			"test-world:1",
		])
			expect(wire).not.toContain(hidden);
		expect(
			f.store.publicationFeed("test-world", principal, {
				limit: 100,
				after: null,
			}),
		).toEqual(feed);
		const postId = published.postId;
		if (!postId) throw Error("Missing post");
		expect(f.store.publicationReadCursor("test-world", principal)).toEqual({
			revision: 0,
			postId: null,
		});
		const beforeInputs = f.store.lifeInputs("test-world"),
			beforeLife = f.store.lifeSnapshot("test-world");
		expect(
			f.store.setPublicationReadCursor("test-world", principal, {
				expectedRevision: 0,
				postId,
			}),
		).toEqual({ revision: 1, postId });
		expect(() =>
			f.store.setPublicationReadCursor("test-world", principal, {
				expectedRevision: 0,
				postId,
			}),
		).toThrow();
		expect(f.store.lifeInputs("test-world")).toEqual(beforeInputs);
		expect(f.store.lifeSnapshot("test-world")).toEqual(beforeLife);
		f.store.withdrawPublicationPost("test-world", postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			f.store.publicationFeed("test-world", principal, {
				limit: 100,
				after: null,
			}).items,
		).toEqual([]);
		expect(
			f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			}),
		).toEqual(published);
		f.store.close();
		const reopened = new WorldStore(path, () => 1000);
		try {
			expect(
				reopened.publicationFeed("test-world", principal, {
					limit: 100,
					after: null,
				}).items,
			).toEqual([]);
			expect(reopened.publicationJob("test-world", f.job.id).postId).toBe(
				postId,
			);
			expect(reopened.publicationReadCursor("test-world", principal)).toEqual({
				revision: 1,
				postId: null,
			});
		} finally {
			reopened.close();
		}
	} finally {
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("publication authority changing during narration withholds delivery without discarding known model usage", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-feed-revoke-")),
		path = join(root, "world.sqlite"),
		f = narrated(path);
	try {
		const {
			worldId: _w,
			revision,
			...config
		} = f.store.lifeConfig("test-world");
		f.store.setLifeConfig("test-world", revision, {
			...config,
			publication: { mode: "manual", recipientIds: [] },
		});
		expect(() =>
			f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			}),
		).toThrow();
		expect(f.store.publicationJob("test-world", f.job.id).postId).toBeNull();
		const run = f.store.beginPublicationRun(
			"test-world",
			f.run.input,
			"owner",
			100,
		);
		if (!run.lease) throw Error("Missing recovered owner");
		expect(
			f.store.completePublicationJob(run.lease, run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			}).status,
		).toBe("withheld");
	} finally {
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

for (const owner of ["chain", "post"] as const)
	test(`published job requires its ${owner} receipt graph on actual reopen`, () => {
		const root = mkdtempSync(join(tmpdir(), "lina-publication-owner-")),
			path = join(root, "world.sqlite"),
			f = narrated(path);
		try {
			f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			});
			f.store.close();
			const db = new DatabaseSync(path);
			try {
				db.exec("PRAGMA foreign_keys=OFF");
				for (const table of owner === "chain"
					? [
							"life_publication_chain_charges",
							"life_publication_chain_roots",
							"life_publication_chain_actions",
							"life_publication_chain_state",
						]
					: [
							"life_publication_post_requests",
							"life_publication_post_receipts",
							"life_publication_posts",
							"life_publication_post_history",
						])
					db.exec(`DELETE FROM ${table}`);
			} finally {
				db.close();
			}
			expect(() => new WorldStore(path, () => 1000).close()).toThrow();
		} finally {
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
