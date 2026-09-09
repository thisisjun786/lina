import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LifeModelRequest } from "../src/world/autonomy-types.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../src/world/publication-model.ts";
import { WorldStore } from "../src/world/store.ts";
import { publicationAuthor } from "./life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

test("publication freezes model selection with material and restores it without changing legacy jobs", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-selection-"));
	const path = join(root, "world.sqlite");
	const store = publicationStoreFixture(path);
	try {
		const run = store.beginPublicationRun(
			"test-world",
			{
				requestKey: "selected",
				expectedConfigRevision: 1,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			"owner",
			100,
		);
		const item = run.batch[0];
		if (!run.lease || !item) throw Error("Missing publication");
		const lease = run.lease;
		const original = store.publicationJob("test-world", item.jobId);
		expect(Object.hasOwn(original, "modelSelection")).toBe(false);
		const fields = {
			profileId: "author",
			provider: "synthetic",
			model: "narrator",
			reasoning: "low" as const,
			maxOutputTokens: 512,
			settingsRevision: 1,
		};
		const selected = { ...fields, routeFingerprint: lifeDigest(fields) };
		const wrongRoute = { ...fields, model: "not-the-authored-model" };
		expect(() =>
			store.freezePublicationJob(
				lease,
				run.id,
				item.jobId,
				publicationAuthor,
				1,
				{
					...wrongRoute,
					routeFingerprint: lifeDigest(wrongRoute),
				},
			),
		).toThrow();
		expect(store.publicationJob("test-world", item.jobId)).toEqual(original);
		const frozen = store.freezePublicationJob(
			run.lease,
			run.id,
			item.jobId,
			publicationAuthor,
			1,
			selected,
		);
		expect(frozen.modelSelection).toEqual(selected);
		expect(() =>
			store.freezePublicationJob(
				lease,
				run.id,
				item.jobId,
				publicationAuthor,
				1,
				{
					...selected,
					reasoning: "high",
					routeFingerprint: lifeDigest({ ...fields, reasoning: "high" }),
				},
			),
		).toThrow();
		store.close();
		const reopened = new WorldStore(path);
		try {
			expect(reopened.publicationJob("test-world", item.jobId)).toEqual(frozen);
		} finally {
			reopened.close();
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("selected publication rejects legacy or altered requests and clears its selection only for a new retry", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-selection-retry-"));
	const path = join(root, "world.sqlite");
	const store = publicationStoreFixture(path);
	try {
		const run = store.beginPublicationRun(
			"test-world",
			{
				requestKey: "run",
				expectedConfigRevision: 1,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			"owner",
			100,
		);
		const item = run.batch[0],
			lease = run.lease;
		if (!item || !lease) throw Error("Missing publication");
		const fields = {
			profileId: "author",
			provider: "synthetic",
			model: "narrator",
			reasoning: "low" as const,
			maxOutputTokens: 128,
			settingsRevision: 1,
		};
		const selection = { ...fields, routeFingerprint: lifeDigest(fields) };
		const job = store.freezePublicationJob(
			lease,
			run.id,
			item.jobId,
			publicationAuthor,
			1,
			selection,
		);
		const common = {
			id: publicationModelId(job.attemptId),
			worldId: job.worldId,
			jobId: job.id,
			lane: "publication" as const,
			agentId: job.authorAgentId,
			provider: "synthetic",
			model: "narrator",
			modelSettingsRevision: 1,
			...buildPublicationModelInput(job),
			limits: {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 20000,
				maxOutputBytes: 10000,
				timeoutMs: 1000,
			},
		};
		const prepare = (request: LifeModelRequest) =>
			store.preparePublicationModel(lease, run.id, {
				version: 1,
				request,
				inputDigest: lifeDigest(request),
				capabilityFingerprint: "a".repeat(64),
				nativeReference: "selected-publication",
			});
		expect(() => prepare({ ...common, version: 2 })).toThrow();
		const altered = { ...fields, reasoning: "high" as const };
		expect(() =>
			prepare({
				...common,
				version: 3,
				selection: { ...altered, routeFingerprint: lifeDigest(altered) },
			}),
		).toThrow();
		expect(() =>
			prepare({
				...common,
				version: 3,
				selection,
				limits: { ...common.limits, maxOutputTokens: 129 },
			}),
		).toThrow();
		expect(store.publicationModelRecords(job.worldId, job.id)).toEqual([]);
		prepare({ ...common, version: 3, selection });
		const failed = store.failPublicationJob(lease, run.id, job.id, "test");
		store.advancePublicationRun(lease, run.id, job.id);
		store.releaseLifeLease(lease, 1000);
		const retried = store.retryPublicationJob(job.worldId, job.id, {
			requestKey: "retry",
			expectedRevision: failed.revision,
		});
		expect(retried.attempt).toBe(2);
		expect(Object.hasOwn(retried, "modelSelection")).toBe(false);
		expect(retried.material).toBeNull();
		store.close();
		const reopened = new WorldStore(path);
		try {
			expect(reopened.publicationJob(job.worldId, job.id)).toEqual(retried);
			expect(
				reopened.publicationModelRecords(job.worldId, job.id)[0]?.prepared
					.request,
			).toMatchObject({ version: 3, selection });
		} finally {
			reopened.close();
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("startup rejects a self-consistent selection pointing outside the authored route before any model receipt", () => {
	const root = mkdtempSync(
		join(tmpdir(), "lina-publication-selection-corrupt-"),
	);
	const path = join(root, "world.sqlite");
	const store = publicationStoreFixture(path);
	try {
		const run = store.beginPublicationRun(
			"test-world",
			{
				requestKey: "run",
				expectedConfigRevision: 1,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			"owner",
			100,
		);
		const item = run.batch[0],
			lease = run.lease;
		if (!item || !lease) throw Error("Missing publication");
		const fields = {
			profileId: "author",
			provider: "synthetic",
			model: "narrator",
			reasoning: "low" as const,
			maxOutputTokens: 128,
			settingsRevision: 1,
		};
		const job = store.freezePublicationJob(
			lease,
			run.id,
			item.jobId,
			publicationAuthor,
			1,
			{ ...fields, routeFingerprint: lifeDigest(fields) },
		);
		store.close();
		const wrong = { ...fields, model: "foreign" };
		const corrupt = {
			...job,
			modelSelection: { ...wrong, routeFingerprint: lifeDigest(wrong) },
		};
		const db = new DatabaseSync(path);
		try {
			for (const table of [
				"life_publication_jobs",
				"life_publication_job_history",
			]) {
				db.prepare(
					`UPDATE ${table} SET job_json=?,digest=? WHERE job_id=? AND revision=?`,
				).run(
					JSON.stringify(corrupt),
					lifeDigest(corrupt),
					job.id,
					job.revision,
				);
			}
		} finally {
			db.close();
		}
		expect(() => new WorldStore(path)).toThrow("authored route");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
