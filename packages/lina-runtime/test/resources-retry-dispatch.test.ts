import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import type { Resource } from "../../lina-memory/src/resources/types.ts";
import { resourceRoutes } from "../src/fleet/resource-routes.ts";

const owner = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const stranger = {
	principalId: "agent:b",
	agentId: "b",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};
const generation = {
	policyRevision: 1,
	modelSettingsRevision: 1,
	routeKey: "route1",
	estimatorId: "test",
	maxAttempts: 1,
};
const request = (path: string, method = "GET", body?: unknown) =>
	new Request(`http://127.0.0.1:19999${path}`, {
		method,
		headers: {
			host: "127.0.0.1:19999",
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});

function createDoc(
	store: ResourceStore,
	operationId: string,
	visibility: "private" | "shared" = "shared",
) {
	return store.create(owner, {
		operationId,
		kind: "document",
		title: operationId,
		visibility,
		mediaType: "text/plain",
		bytes: new TextEncoder().encode("원문"),
	});
}

function extractJob(store: ResourceStore, id: string) {
	const job = store.indexing.list(owner, id).find((j) => j.kind === "extract");
	if (!job) throw Error("missing extract job");
	return job;
}

async function retry(
	store: ResourceStore,
	jobId: string,
	onStored: (resource: Resource) => void,
	scope = owner,
) {
	return resourceRoutes(
		request(`/api/resources/jobs/${jobId}/retry`, "POST", {}),
		{ store, scope: () => scope, onStored },
	);
}

test("eligible unavailable job retry notifies onStored once with owning resource", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-retry-ok-"));
	const store = new ResourceStore(root, limits, () => generation);
	const callbacks = { onStored(_resource: Resource) {} };
	const onStored = spyOn(callbacks, "onStored");
	try {
		const doc = createDoc(store, "retry-ok");
		const job = extractJob(store, doc.id);
		store.indexing.defer(owner, job.id, "undecodable_text", "unavailable");
		const response = await retry(store, job.id, callbacks.onStored);
		expect(response?.status).toBe(200);
		expect(store.indexing.get(owner, job.id).state).toBe("pending");
		expect(onStored).toHaveBeenCalledTimes(1);
		expect(onStored.mock.calls[0]?.[0]).toMatchObject({ id: doc.id });
	} finally {
		onStored.mockRestore();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejected pending stale foreign-private and exhausted retries do not notify onStored", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-retry-reject-"));
	const store = new ResourceStore(root, limits, () => generation);
	const callbacks = { onStored(_resource: Resource) {} };
	const onStored = spyOn(callbacks, "onStored");
	try {
		const pending = createDoc(store, "retry-pending");
		const pendingJob = extractJob(store, pending.id);
		expect(
			(await retry(store, pendingJob.id, callbacks.onStored))?.status,
		).toBe(400);

		const stale = createDoc(store, "retry-stale");
		const staleJob = extractJob(store, stale.id);
		store.indexing.defer(owner, staleJob.id, "provider_failed", "unavailable");
		store.update(owner, {
			id: stale.id,
			operationId: "change-source",
			expectedRevision: stale.revision,
			title: "changed",
		});
		expect((await retry(store, staleJob.id, callbacks.onStored))?.status).toBe(
			409,
		);

		const secret = createDoc(store, "retry-foreign", "private");
		const secretJob = extractJob(store, secret.id);
		store.indexing.defer(
			owner,
			secretJob.id,
			"undecodable_text",
			"unavailable",
		);
		expect(
			(await retry(store, secretJob.id, callbacks.onStored, stranger))?.status,
		).toBe(404);

		const exhausted = createDoc(store, "retry-exhausted");
		const exhaustedJob = extractJob(store, exhausted.id);
		store.indexing.fail(
			store.indexing.prepare(owner, exhaustedJob.id),
			"provider_failed",
		);
		expect(
			(await retry(store, exhaustedJob.id, callbacks.onStored))?.status,
		).toBe(400);

		expect(onStored).toHaveBeenCalledTimes(0);
	} finally {
		onStored.mockRestore();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
