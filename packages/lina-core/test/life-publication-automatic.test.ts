import { expect, test } from "bun:test";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

test("automatic publication plans pending source without writes and changes its key only after explicit retry", () => {
	const store = publicationStoreFixture();
	try {
		const initial = store.publicationExecutionStatus("test-world");
		const input = store.automaticPublicationInput("test-world");
		expect(input?.mode).toBe("automatic");
		expect(store.automaticPublicationInput("test-world")).toEqual(input);
		expect(store.pendingPublicationRuns("test-world")).toEqual([]);
		expect(store.publicationExecutionStatus("test-world")).toEqual(initial);
		if (!input) throw Error("Missing candidate");
		const run = store.beginPublicationRun("test-world", input, "test", 100);
		expect(store.automaticPublicationInput("test-world")).toEqual(input);
		const job = run.batch[0];
		if (!job || !run.lease) throw Error("Missing batch");
		const failed = store.failPublicationJob(
			run.lease,
			run.id,
			job.jobId,
			"test",
		);
		store.advancePublicationRun(run.lease, run.id, job.jobId);
		store.releaseLifeLease(run.lease, 1000);
		expect(store.automaticPublicationInput("test-world")).toBeNull();
		store.retryPublicationJob("test-world", job.jobId, {
			expectedRevision: failed.revision,
			requestKey: "retry",
		});
		const retry = store.automaticPublicationInput("test-world");
		expect(retry?.requestKey).not.toBe(input.requestKey);
		expect(retry?.mode).toBe("automatic");
	} finally {
		store.close();
	}
});

test("paused or manual publication never creates a new automatic run but retains a saved run for reconciliation", () => {
	const store = publicationStoreFixture();
	try {
		const input = store.automaticPublicationInput("test-world");
		if (!input) throw Error("Missing candidate");
		const { worldId, revision, ...config } = store.lifeConfig("test-world");
		store.setLifeConfig(worldId, revision, {
			...config,
			run: { mode: "paused" },
		});
		expect(store.automaticPublicationInput(worldId)).toBeNull();
		store.setLifeConfig(worldId, revision + 1, config);
		const resumed = store.automaticPublicationInput(worldId);
		if (!resumed) throw Error("Missing resumed candidate");
		store.beginPublicationRun(worldId, resumed, "test", 100);
		store.setLifeConfig(worldId, revision + 2, {
			...config,
			run: { mode: "paused" },
		});
		expect(store.automaticPublicationInput(worldId)).toEqual(resumed);
	} finally {
		store.close();
	}
});
