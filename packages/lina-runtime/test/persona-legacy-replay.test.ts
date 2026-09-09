import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import type { IdentityPolicySnapshot } from "../../lina-core/src/world/life-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { runLifePublication } from "../src/life/publication.ts";
import { createLifeRuntime } from "../src/life/runtime.ts";
import { RuntimeClock, RuntimeModel } from "./life-runtime-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const fixtures: ReturnType<typeof runtimeStoreFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

const signal = () => new AbortController().signal;

function withVersionedIdentity(
	base: ReturnType<typeof runtimeStoreFixture>["options"],
	defaultVersion: 1 | 2,
) {
	const v1 = {
		...base.identity(),
		identity: {
			...base.identity().identity,
			version: 1 as const,
		},
	};
	const v2: {
		identity: IdentityPolicySnapshot;
		profiles: ReturnType<typeof base.identity>["profiles"];
		modelSettingsRevision: number;
	} = {
		...v1,
		identity: {
			version: 2,
			profiles: v1.identity.profiles.map((profile) => ({
				...profile,
				personalBehavior: null,
				sourceStamp: null,
			})),
		},
	};
	const versions: (1 | 2 | undefined)[] = [];
	return {
		v1,
		v2,
		versions,
		identity(_worldId: string, version?: 1 | 2) {
			versions.push(version);
			return version === 1 || (version === undefined && defaultVersion === 1)
				? v1
				: v2;
		},
	};
}

test("upgraded v2 identity callback still completes a pending v1 LIFE step from stored bytes", async () => {
	const f = runtimeStoreFixture(false);
	fixtures.push(f);
	const entered = Promise.withResolvers<void>();
	const hold = Promise.withResolvers<void>();
	const original = f.model.text;
	f.model.onComplete = async (request) => {
		if (request.request.lane === "director") entered.resolve();
		await hold.promise;
		return f.model.result(request);
	};
	const firstRun = f.runner.run("test-world", "legacy-v1", 1, signal());
	await entered.promise;
	const pendingId = f.store.lifeStatus(
		"test-world",
		f.clock.now(),
	).activeStepId;
	if (!pendingId) throw Error("expected pending LIFE step");
	const pending = f.store.lifeStep("test-world", pendingId);
	expect(pending.source.identity.version).toBe(1);
	const frozenIdentity = structuredClone(pending.source.identity);
	const frozenSource = structuredClone(pending.source);
	const frozenModels = pending.models.map((row) => ({
		id: row.prepared.request.id,
		lane: row.prepared.request.lane,
		inputDigest: row.prepared?.inputDigest ?? null,
		request: structuredClone(row.prepared?.request ?? null),
	}));
	hold.resolve();
	await f.runner.close();
	f.store.close();
	await firstRun.catch(() => undefined);

	const store = new WorldStore(f.path, () => f.clock.now());
	const model = new RuntimeModel();
	model.text = original;
	const upgraded = withVersionedIdentity({ ...f.options, store, model }, 2);
	const runtime = createLifeRuntime({
		...f.options,
		store,
		model,
		identity: upgraded.identity,
		owner: "reopened-v2-default",
		worldIds: () => ["test-world"],
		config: (worldId) => store.lifeConfig(worldId),
		acquireLease: () => {
			throw Error("Unexpected schedule acquisition");
		},
		onError: () => {
			throw Error("Unexpected scheduler failure");
		},
	});
	try {
		const restored = store.lifeStep("test-world", pendingId);
		expect(restored.status).not.toBe("accepted");
		expect(restored.source.identity).toEqual(frozenIdentity);
		expect(restored.source.identity.version).toBe(1);
		expect(lifeDigest(restored.source)).toBe(lifeDigest(frozenSource));
		const resumed = await runtime.run("test-world", "legacy-v1", 1, signal());
		expect(resumed.status).toBe("accepted");
		expect(resumed.source.identity.version).toBe(1);
		expect(resumed.source.identity).toEqual(frozenIdentity);
		expect(lifeDigest(resumed.source)).toBe(lifeDigest(frozenSource));
		expect(resumed.id).toBe(pendingId);
		for (const frozen of frozenModels) {
			const row = resumed.models.find(
				(item) => item.prepared.request.id === frozen.id,
			);
			expect(row?.prepared?.inputDigest).toBe(frozen.inputDigest);
			expect(row?.prepared?.request).toEqual(frozen.request);
		}
		expect(upgraded.versions.includes(1)).toBe(true);
		const next = await runtime.run("test-world", "new-v2", 1, signal());
		expect(next.source.identity.version).toBe(2);
		expect(next.id).not.toBe(resumed.id);
	} finally {
		await runtime.close();
		store.close();
	}
});

test("legacy publication resumes after reopen with its frozen author and exact prepared request", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-persona-publication-")),
		path = join(root, "world.sqlite");
	const f = preparedPublicationFixture(path);
	f.store.close();
	const store = new WorldStore(path, () => 1000),
		model = new RuntimeModel(),
		clock = new RuntimeClock();
	clock.time = 1000;
	model.text = () =>
		JSON.stringify({
			kind: "post",
			segments: [{ kind: "imaginative", text: "A public moment." }],
		});
	let legacyChecks = 0;
	try {
		const restored = store.publicationJob("test-world", f.job.id);
		expect(restored.author).toEqual(publicationAuthor);
		const run = await runLifePublication({
			publication: {
				store,
				author: (_world, _agent, frozen) => {
					if (frozen && !("version" in frozen)) {
						legacyChecks++;
						return publicationAuthor;
					}
					return { ...publicationAuthor, version: 2, sourceStamp: null };
				},
			},
			run: store.publicationRun("test-world", f.run.id),
			invocation: "manual",
			model,
			clock,
			signal: signal(),
			lease: () => f.lease,
			guard: () => {},
			identity: () => ({ modelSettingsRevision: 1 }),
			beforePrepare: undefined,
		});
		expect(legacyChecks).toBeGreaterThan(0);
		expect(store.publicationJob("test-world", f.job.id).status).toBe(
			"published",
		);
		expect(model.requests).toEqual([f.prepared.request]);
		expect(
			store.publicationModelRecords("test-world", f.job.id)[0]?.prepared,
		).toEqual(f.prepared);
		const replay = store.publicationRun("test-world", run.id);
		expect(replay).toEqual(run);
	} finally {
		await model.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
