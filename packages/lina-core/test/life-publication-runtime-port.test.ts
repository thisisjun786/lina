import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../src/world/store.ts";
import { preparedPublicationFixture } from "./life-publication-prepared-fixture.ts";

test("publication outbound requires the exact dispatched model receipt under current authority", () => {
	const f = preparedPublicationFixture(":memory:");
	try {
		const { author, modelSettingsRevision } = f.job;
		if (!author || modelSettingsRevision === null)
			throw Error("Missing author");
		const request = f.prepared.request;
		expect(() =>
			f.store.assertPublicationOutbound(request, author, modelSettingsRevision),
		).toThrow();
		f.store.dispatchPublicationModel(f.lease, f.run.id, f.job.id, request.id);
		expect(
			f.store.assertPublicationOutbound(request, author, modelSettingsRevision)
				.id,
		).toBe(f.job.id);
		expect(() =>
			f.store.assertPublicationOutbound(
				{
					...request,
					limits: {
						...request.limits,
						maxInputTokens: request.limits.maxInputTokens + 1,
					},
				},
				author,
				modelSettingsRevision,
			),
		).toThrow();
		f.store.releaseLifeLease(f.lease, 1000);
		expect(() =>
			f.store.assertPublicationOutbound(request, author, modelSettingsRevision),
		).toThrow();
	} finally {
		f.store.close();
	}
});

test("native publication selection requires a prepared job in its currently owned run", () => {
	const f = preparedPublicationFixture(":memory:");
	try {
		const { author, modelSettingsRevision } = f.job;
		if (!author || modelSettingsRevision === null)
			throw Error("Missing author");
		expect(
			f.store.assertPublicationDispatch(
				"test-world",
				f.job.id,
				author,
				modelSettingsRevision,
			).id,
		).toBe(f.job.id);
		f.store.releaseLifeLease(f.lease, 1000);
		expect(() =>
			f.store.assertPublicationDispatch(
				"test-world",
				f.job.id,
				author,
				modelSettingsRevision,
			),
		).toThrow();
	} finally {
		f.store.close();
	}
});

test("publication execution reads real saved requests and shared usage without an autonomous pack, including reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-port-"));
	const path = join(root, "world.sqlite");
	const f = preparedPublicationFixture(path);
	let reopened: WorldStore | undefined;
	try {
		const records = f.store.publicationModelRecords("test-world", f.job.id);
		expect(records).toHaveLength(1);
		expect(records[0]?.prepared).toEqual(f.prepared);
		expect(records[0]?.status).toBe("prepared");
		const status = f.store.publicationExecutionStatus("test-world");
		expect(status.usage.reservedInputTokens).toBe(100);
		expect(status.usage.reservedOutputTokens).toBe(100);
		expect(status.schedule?.lease).toEqual(f.lease);
		expect(f.store.snapshot("test-world").revision).toBe(1);
		expect(f.store.lifeSnapshot("test-world").revision).toBe(1);
		expect(() =>
			f.store.publicationModelRecords("test-world", "unknown"),
		).toThrow();
		f.store.close();
		reopened = new WorldStore(path, () => 1000);
		expect(reopened.publicationModelRecords("test-world", f.job.id)).toEqual(
			records,
		);
		expect(reopened.publicationExecutionStatus("test-world")).toEqual(status);
	} finally {
		reopened?.close();
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
