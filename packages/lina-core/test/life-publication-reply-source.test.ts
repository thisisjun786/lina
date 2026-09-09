import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../src/world/publication-model.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";

function published(path: string, eventSummary?: string) {
	const f = preparedPublicationFixture(path, eventSummary);
	const claim = f.job.material?.allowedClaims[0];
	if (!claim) throw Error("Missing fixture claim");
	f.store.dispatchPublicationModel(
		f.lease,
		f.run.id,
		f.job.id,
		f.prepared.request.id,
	);
	f.store.finishPublicationModel(
		"test-world",
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
				threadId: "synthetic",
				turnId: "turn",
				text: JSON.stringify({
					kind: "post",
					segments: [
						{ kind: "claim", claimId: claim.id },
						{ kind: "imaginative", text: "Perhaps we will meet again." },
					],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		},
	);
	const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
		author: publicationAuthor,
		modelSettingsRevision: 1,
	});
	if (!job.postId) throw Error("Missing fixture post");
	const { grant } = f.store.mintPublicationViewer("test-world", {
		requestKey: "viewer",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	});
	return {
		...f,
		postId: job.postId,
		claim,
		grant,
		principal: { kind: "viewer" as const, grantId: grant.id },
	};
}
const limits = { maxChars: 20000, maxRecords: 100 };

test.each(["claim-source", "parent-roots", "snapshot-pair"] as const)(
	"reopen rejects rehashed reply %s that disagrees with the actual parent history",
	(corruption) => {
		const root = mkdtempSync(join(tmpdir(), "lina-reply-history-")),
			path = join(root, "world.sqlite"),
			f = published(path);
		try {
			f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
			f.store.resharePublication("test-world", f.principal, f.postId, {
				requestKey: "share",
				expectedPostRevision: 1,
			});
			const input = f.store.automaticPublicationInput("test-world");
			if (!input) throw Error("Missing reply candidate");
			const run = f.store.beginPublicationRun(
					"test-world",
					input,
					"owner",
					100,
				),
				item = run.batch[0];
			if (!run.lease || !item) throw Error("Missing reply batch");
			const job = f.store.freezePublicationJob(
				run.lease,
				run.id,
				item.jobId,
				publicationAuthor,
				1,
			);
			expect(job.version).toBe(2);
			f.store.close();
			new WorldStore(path, () => 1000).close();
			const db = new DatabaseSync(path);
			try {
				for (const table of [
					"life_publication_job_history",
					"life_publication_jobs",
				]) {
					for (const row of db
						.prepare(`SELECT rowid,job_json FROM ${table} WHERE job_id=?`)
						.all(job.id)) {
						const value = JSON.parse(String(row["job_json"]));
						if (!value.material) continue;
						const material = value.material;
						if (corruption === "claim-source") {
							const claim = material.allowedClaims[0];
							claim.sourceId = "unpublished-source";
							const { id: _claimId, ...body } = claim;
							claim.id = `claim-${lifeDigest(body)}`;
						} else if (corruption === "parent-roots")
							material.parentRoots[0].rootId = "forged-root";
						else material.source.worldRevision++;
						const { id: _id, digest: _digest, ...body } = material;
						const identified = { ...body, id: `material-${lifeDigest(body)}` };
						value.material = { ...identified, digest: lifeDigest(identified) };
						db.prepare(
							`UPDATE ${table} SET job_json=?,digest=? WHERE rowid=?`,
						).run(JSON.stringify(value), lifeDigest(value), row["rowid"] ?? 0);
					}
				}
			} finally {
				db.close();
			}
			expect(() => new WorldStore(path, () => 1000).close()).toThrow();
		} finally {
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("reply source authenticates real user text and reshare claim provenance without admitting work", () => {
	const f = published(":memory:");
	try {
		const { store, postId, principal } = f;
		const before = store.lifeSnapshot("test-world");
		expect(
			store.publicationReplyMaterial(
				"test-world",
				postId,
				"lina",
				"friends",
				limits,
			),
		).toBeNull();
		const reply = store.replyToPublication("test-world", principal, postId, {
			requestKey: "reply",
			expectedPostRevision: 1,
			text: "USER_INVENTED_SECRET",
		});
		const share = store.resharePublication("test-world", principal, postId, {
			requestKey: "share",
			expectedPostRevision: 1,
		});
		if (!reply.postId || !share.postId) throw Error("Missing parent fixture");
		const text = store.publicationReplyMaterial(
			"test-world",
			reply.postId,
			"lina",
			"friends",
			limits,
		);
		const shared = store.publicationReplyMaterial(
			"test-world",
			share.postId,
			"lina",
			"friends",
			limits,
		);
		expect(text?.allowedClaims).toEqual([]);
		expect(text?.parent.segments).toEqual([
			{ kind: "user_authored", text: "USER_INVENTED_SECRET" },
		]);
		expect(shared?.allowedClaims).toEqual([f.claim]);
		expect(shared?.authority.posts.map((p) => p.id).sort()).toEqual(
			[postId, share.postId].sort(),
		);
		expect(shared?.authority.grants).toEqual([{ id: f.grant.id, revision: 1 }]);
		expect(shared?.source.origin).toEqual(f.job.material?.source);
		expect(JSON.stringify(shared)).not.toContain("hidden key");
		expect(store.publicationJob("test-world", f.job.id).status).toBe(
			"published",
		);
		expect(store.lifeSnapshot("test-world")).toEqual(before);
	} finally {
		f.store.close();
	}
});

test("current reply sources reject original grant revocation and parent withdrawal after a real reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-reply-source-")),
		path = join(root, "world.sqlite");
	const f = published(path);
	let reopened: WorldStore | undefined;
	try {
		const share = f.store.resharePublication(
			"test-world",
			f.principal,
			f.postId,
			{ requestKey: "share", expectedPostRevision: 1 },
		);
		if (!share.postId) throw Error("Missing share");
		const material = f.store.publicationReplyMaterial(
			"test-world",
			share.postId,
			"lina",
			"friends",
			limits,
		);
		expect(material).not.toBeNull();
		f.store.close();
		reopened = new WorldStore(path, () => 1000);
		expect(
			reopened.publicationReplyMaterial(
				"test-world",
				share.postId,
				"lina",
				"friends",
				limits,
			),
		).toEqual(material);
		reopened.revokePublicationViewer("test-world", f.grant.id, {
			requestKey: "revoke",
			expectedRevision: 1,
		});
		expect(
			reopened.publicationReplyMaterial(
				"test-world",
				share.postId,
				"lina",
				"friends",
				limits,
			),
		).toBeNull();
		reopened.withdrawPublicationPost("test-world", f.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			reopened.publicationReplyMaterial(
				"test-world",
				share.postId,
				"lina",
				"friends",
				limits,
			),
		).toBeNull();
	} finally {
		reopened?.close();
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["no_reply", "post", "oversize"] as const)(
	"the real publication runner preserves a reply %s result across restart",
	(decision) => {
		const root = mkdtempSync(join(tmpdir(), "lina-reply-execution-")),
			path = join(root, "world.sqlite"),
			f = published(
				path,
				decision === "oversize" ? "s".repeat(2000) : undefined,
			);
		try {
			f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
			const reply =
				decision === "oversize"
					? f.store.resharePublication("test-world", f.principal, f.postId, {
							requestKey: "share",
							expectedPostRevision: 1,
						})
					: f.store.replyToPublication("test-world", f.principal, f.postId, {
							requestKey: "reply",
							expectedPostRevision: 1,
							text: "Do you want to talk?",
						});
			const input = f.store.automaticPublicationInput("test-world");
			expect(input).not.toBeNull();
			if (!input || !reply.postId) throw Error("Missing reply candidate");
			const run = f.store.beginPublicationRun(
					"test-world",
					input,
					"owner",
					100,
				),
				item = run.batch[0],
				lease = run.lease;
			if (!item || !lease) throw Error("Missing reply run");
			const job = f.store.freezePublicationJob(
				lease,
				run.id,
				item.jobId,
				publicationAuthor,
				1,
			);
			expect(job.version).toBe(2);
			if (job.version !== 2) throw Error("Reply job required");
			expect(job.source.parentPostId).toBe(reply.postId);
			const request = {
				...f.prepared.request,
				id: publicationModelId(job.attemptId),
				jobId: job.id,
				...buildPublicationModelInput(job),
				limits: { ...f.prepared.request.limits, maxOutputBytes: 65536 },
			};
			const prepared = {
				...f.prepared,
				request,
				inputDigest: lifeDigest(request),
				nativeReference: "native-reply",
			};
			f.store.preparePublicationModel(lease, run.id, prepared);
			f.store.dispatchPublicationModel(lease, run.id, job.id, request.id);
			f.store.finishPublicationModel("test-world", job.id, request.id, {
				status: "completed",
				result: {
					version: 1,
					requestId: request.id,
					inputDigest: prepared.inputDigest,
					capabilityFingerprint: prepared.capabilityFingerprint,
					nativeReference: prepared.nativeReference,
					provider: "synthetic",
					model: "narrator",
					threadId: "reply-thread",
					turnId: "reply-turn",
					text: JSON.stringify(
						decision === "no_reply"
							? { kind: "no_reply" }
							: {
									kind: "post",
									segments: [
										...(decision === "oversize"
											? [
													{
														kind: "claim",
														claimId: job.material?.allowedClaims[0]?.id,
													},
												]
											: []),
										{
											kind: "imaginative",
											text:
												decision === "oversize"
													? "x".repeat(31800)
													: "I would enjoy hearing more.",
										},
									],
								},
					),
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
					upstreamAttempts: 1,
				},
			});
			if (decision === "oversize") {
				const db = new DatabaseSync(path);
				const counts = () =>
					[
						"life_publication_posts",
						"life_publication_post_history",
						"life_publication_chain_actions",
						"life_publication_observations",
					].map(
						(table) =>
							db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.[
								"count"
							],
					);
				try {
					const before = counts();
					expect(() =>
						f.store.completePublicationJob(lease, run.id, job.id, {
							author: publicationAuthor,
							modelSettingsRevision: 1,
						}),
					).toThrow();
					expect(counts()).toEqual(before);
					expect(f.store.publicationJob("test-world", job.id).status).toBe(
						"ready",
					);
				} finally {
					db.close();
				}
				f.store.close();
				const reopened = new WorldStore(path, () => 1000);
				try {
					expect(reopened.publicationJob("test-world", job.id).status).toBe(
						"ready",
					);
					expect(
						reopened.publicationModelRecords("test-world", job.id)[0]?.status,
					).toBe("completed");
				} finally {
					reopened.close();
				}
				return;
			}
			const skipped = f.store.completePublicationJob(lease, run.id, job.id, {
				author: publicationAuthor,
				modelSettingsRevision: 1,
			});
			expect(skipped.status).toBe(
				decision === "no_reply" ? "skipped" : "published",
			);
			if (decision === "post") {
				const feed = f.store.publicationFeed("test-world", f.principal, {
					limit: 10,
					after: null,
				});
				expect(
					feed.items.find((row) => row.id === skipped.postId),
				).toMatchObject({
					kind: "reply",
					parentPostId: reply.postId,
					author: { kind: "agent", agentId: "lina" },
					segments: [
						{ kind: "imaginative", text: "I would enjoy hearing more." },
					],
				});
			}
			f.store.advancePublicationRun(lease, run.id, job.id);
			expect(f.store.automaticPublicationInput("test-world")).toBeNull();
			if (decision === "post") {
				f.store.revokePublicationViewer("test-world", f.grant.id, {
					requestKey: "revoke-after-publication",
					expectedRevision: 1,
				});
				expect(
					f.store.publicationPost(
						"test-world",
						{ kind: "agent", agentId: "lina" },
						skipped.postId ?? "missing",
					),
				).toBeNull();
			}
			f.store.close();
			const reopened = new WorldStore(path, () => 1000);
			try {
				expect(reopened.publicationJob("test-world", job.id)).toEqual(skipped);
				expect(reopened.automaticPublicationInput("test-world")).toBeNull();
			} finally {
				reopened.close();
			}
		} finally {
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
