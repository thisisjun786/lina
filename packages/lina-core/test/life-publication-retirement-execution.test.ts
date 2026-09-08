import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifeModelReceipts } from "../src/world/autonomy-model-receipts.ts";
import { LifeSchedulePersistence } from "../src/world/autonomy-schedule.ts";
import { PublicationExecution } from "../src/world/publication.ts";
import { PublicationJobs } from "../src/world/publication-jobs.ts";
import { PublicationPersistence } from "../src/world/publication-persistence.ts";
import { PublicationRuns } from "../src/world/publication-runs.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";

// Keep the frozen content/config/lease identical so only current role authority
// can deny execution; real authored migration coverage lives in the store suite.
test.each([
	"freeze",
	"prepare",
	"current",
	"dispatch",
	"outbound",
	"commit",
] as const)(
	"retirement alone blocks %s even when permitted content and all frozen revisions match",
	(boundary) => {
		const root = mkdtempSync(
				join(tmpdir(), "lina-publication-retirement-execution-"),
			),
			path = join(root, "world.sqlite");
		const f = preparedPublicationFixture(path),
			db = new DatabaseSync(path);
		let active = ["lina"],
			materialReads = 0;
		const access = {
			config: () => f.store.lifeConfig("test-world"),
			configAt: () => f.store.lifeConfig("test-world"),
			definition: () => f.store.lifeDefinition("test-world"),
			activeAgents: () => active,
			effects: () => f.store.lifeEffects("test-world"),
			material: () => {
				materialReads++;
				return f.job.material;
			},
			historical: () => f.job.material,
			canPublish: () => true,
			publish: () => {
				throw Error("Retired author reached publication");
			},
		};
		const execution = new PublicationExecution(
			new PublicationPersistence(db, access.definition),
			new PublicationJobs(db),
			new PublicationRuns(db),
			new LifeModelReceipts(db, () => 1000, "publication"),
			new LifeSchedulePersistence(db, () => 1000),
			access,
		);
		try {
			expect(
				execution.assertDispatch("test-world", f.job.id, publicationAuthor, 1)
					.id,
			).toBe(f.job.id);
			if (boundary === "outbound" || boundary === "commit")
				f.store.dispatchPublicationModel(
					f.lease,
					f.run.id,
					f.job.id,
					f.prepared.request.id,
				);
			active = [];
			materialReads = 0;
			if (boundary === "commit") {
				execution.finish("test-world", f.job.id, f.prepared.request.id, {
					status: "completed",
					result: {
						version: 1,
						requestId: f.prepared.request.id,
						inputDigest: f.prepared.inputDigest,
						capabilityFingerprint: f.prepared.capabilityFingerprint,
						nativeReference: f.prepared.nativeReference,
						provider: "synthetic",
						model: "narrator",
						threadId: "thread",
						turnId: "turn",
						text: '{"kind":"no_post"}',
						usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
						upstreamAttempts: 1,
					},
				});
				expect(
					execution.complete(f.lease, f.run.id, f.job.id, {
						author: publicationAuthor,
						modelSettingsRevision: 1,
					}).status,
				).toBe("withheld");
				expect(
					f.store.publicationModelRecords("test-world", f.job.id)[0]?.usage
						.totalTokens,
				).toBe(15);
			} else {
				const call = () => {
					switch (boundary) {
						case "freeze":
							return execution.freeze(
								f.lease,
								f.run.id,
								f.job.id,
								publicationAuthor,
								1,
							);
						case "prepare":
							return execution.prepare(f.lease, f.run.id, f.prepared);
						case "current":
							return execution.assertCurrent(
								"test-world",
								f.job.id,
								publicationAuthor,
								1,
							);
						case "dispatch":
							return execution.dispatch(
								f.lease,
								f.run.id,
								f.job.id,
								f.prepared.request.id,
							);
						case "outbound":
							return execution.assertOutbound(
								f.prepared.request,
								publicationAuthor,
								1,
							);
					}
				};
				expect(call).toThrow(/Publication (disclosure changed|source changed)/);
			}
			expect(materialReads).toBe(0);
		} finally {
			db.close();
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
