import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { FleetResources } from "../src/fleet/resource-runtime.ts";

test("mutation effects dispatch nested and secondary collections after moves and deletion", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-effects-"));
	const owner = new FleetResources({
		root,
		limits: {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		},
		services: () => ({
			estimateText: conservativeEstimator.text,
			estimateMessages: conservativeEstimator.messages,
			estimator: conservativeEstimator,
			systemTokens: 0,
			contextWindow: 32000,
			reserveTokens: 1024,
			summarize: async () => "",
			prepare: () => {
				throw Error("unused");
			},
			resourceInputOverhead: () => 20,
		}),
		policy: defaultEnginePolicy,
		validAgent: () => true,
		assertInstallation: () => {},
	});
	const store = owner.engine.store,
		scope = owner.scope("a");
	const executed: string[] = [];
	let gate:
		| {
				entered: ReturnType<typeof Promise.withResolvers<void>>;
				release: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;
	const original = owner.engine.runPending.bind(owner.engine);
	const run = spyOn(owner.engine, "runPending").mockImplementation(
		async (...args) => {
			executed.push(args[0]);
			if (gate) {
				const held = gate;
				gate = undefined;
				held.entered.resolve();
				await held.release.promise;
			}
			return original(...args);
		},
	);
	const create = (id: string, parentId: string | null = null) => {
		const r = store.create(scope, {
			operationId: id,
			kind: "collection",
			title: id,
			visibility: "private",
			parentId,
		});
		owner.scheduleStored("a", r);
		return r;
	};
	try {
		const top = create("top"),
			folder = create("folder", top.id),
			other = create("other");
		await owner.drain();
		executed.length = 0;
		let doc = store.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "doc",
			visibility: "private",
			parentId: folder.id,
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("source"),
		});
		owner.scheduleStored("a", doc);
		await owner.drain();
		expect(new Set(executed)).toEqual(new Set([doc.id, folder.id, top.id]));
		executed.length = 0;
		doc = store.update(scope, {
			id: doc.id,
			operationId: "move",
			expectedRevision: doc.revision,
			parentId: other.id,
			collectionIds: [folder.id],
		});
		owner.scheduleStored("a", doc);
		owner.scheduleStored("a", doc);
		await owner.drain();
		expect(new Set(executed)).toEqual(
			new Set([doc.id, folder.id, top.id, other.id]),
		);
		expect(executed.length).toBe(4);
		const survivor = store.create(scope, {
			operationId: "survivor",
			kind: "document",
			title: "survivor",
			visibility: "private",
			parentId: other.id,
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("survives"),
		});
		owner.scheduleStored("a", survivor);
		await owner.drain();
		executed.length = 0;
		doc = store.update(scope, {
			id: doc.id,
			operationId: "delete",
			expectedRevision: doc.revision,
			deleted: true,
		});
		owner.scheduleStored("a", doc);
		await owner.drain();
		// Old empty digests are reused, while the new surviving-child digest is dispatched.
		expect(executed).toEqual([other.id]);
		for (const r of [folder, top, other])
			expect(
				store.indexing.list(scope, r.id).some((j) => j.state === "pending"),
			).toBe(false);
		executed.length = 0;
		const foreign = store.create(owner.scope("b"), {
			operationId: "foreign",
			kind: "collection",
			title: "private b",
			visibility: "private",
		});
		owner.scheduleStored("a", foreign);
		await owner.drain();
		expect(executed).toEqual([]);
		owner.scheduleStored("b", foreign);
		await owner.drain();
		expect(executed).toEqual([foreign.id]);
		executed.length = 0;
		const held = {
			entered: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		};
		gate = held;
		owner.scheduleStored("b", foreign);
		await held.entered.promise;
		try {
			const newer = store.update(owner.scope("b"), {
				id: foreign.id,
				operationId: "while-running",
				expectedRevision: foreign.revision,
				title: "updated",
			});
			owner.scheduleStored("b", newer);
			owner.scheduleStored("b", newer);
		} finally {
			held.release.resolve();
		}
		await owner.drain();
		expect(executed).toEqual([foreign.id, foreign.id]);
	} finally {
		run.mockRestore();
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Fleet HTTP retry and child writes reach the resource worker", async () => {
	const { fleetLifeFixture } = await import("./life-runtime-fleet-fixture.ts");
	const { z } = await import("zod");
	let owner: FleetResources | undefined;
	const schedule = FleetResources.prototype.schedule;
	const observed = spyOn(
		FleetResources.prototype,
		"schedule",
	).mockImplementation(function (this: FleetResources, ...args) {
		owner = this;
		return schedule.apply(this, args);
	});
	const f = await fleetLifeFixture();
	const base = `http://127.0.0.1:${f.app.port}/api/agents/lina/resources`;
	const jobs = z.object({
		jobs: z.array(
			z.object({ id: z.string(), kind: z.string(), state: z.string() }),
		),
	});
	const post = async (path: string, input: unknown) => {
		const r = await fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		expect(r.ok).toBe(true);
		return r.json();
	};
	const drain = async () => {
		if (!owner) throw Error("resource was not scheduled");
		await owner.drain();
	};
	try {
		f.setup();
		const folder = z.object({ id: z.string() }).parse(
			await post("", {
				operationId: "folder",
				kind: "collection",
				title: "folder",
				visibility: "private",
			}),
		);
		await drain();
		const doc = z.object({ id: z.string() }).parse(
			await post("", {
				operationId: "doc",
				kind: "document",
				title: "doc",
				parentId: folder.id,
				visibility: "private",
				mediaType: "text/plain",
				text: "source",
			}),
		);
		await drain();
		const parent = jobs.parse(
			await (await fetch(base + "/" + folder.id)).json(),
		);
		expect(parent.jobs.map((j) => j.state)).toEqual(["unavailable"]);
		const before = jobs.parse(await (await fetch(base + "/" + doc.id)).json());
		const brief = before.jobs.find((j) => j.kind === "brief");
		expect(brief?.state).toBe("unavailable");
		if (!brief) throw Error("missing brief");
		await post("/jobs/" + brief.id + "/retry", {});
		await drain();
		const after = jobs.parse(await (await fetch(base + "/" + doc.id)).json());
		expect(after.jobs.find((j) => j.id === brief.id)?.state).toBe(
			"unavailable",
		);
		expect(after.jobs.find((j) => j.kind === "extract")?.state).toBe("ready");
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
		observed.mockRestore();
	}
});

test("mutation effects survive a reopened operation receipt", async () => {
	const { ResourceStore } = await import(
		"../../lina-memory/src/resources/store.ts"
	);
	const root = mkdtempSync(join(tmpdir(), "lina-effects-replay-"));
	const limits = {
		maxFileBytes: 4096,
		maxCatalogBytes: 8192,
		maxExtractionBytes: 4096,
	};
	const scope = {
		principalId: "agent:a",
		agentId: "a",
		allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
	};
	let store = new ResourceStore(root, limits);
	try {
		const folder = store.create(scope, {
			operationId: "folder",
			kind: "collection",
			title: "folder",
			visibility: "private",
		});
		const input = {
			operationId: "doc",
			kind: "document" as const,
			title: "doc",
			visibility: "private" as const,
			parentId: folder.id,
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("source"),
		};
		const first = store.create(scope, input);
		const expected = store.affectedResources(first);
		expect(expected).toContain(folder.id);
		store.close();
		store = new ResourceStore(root, limits);
		const replay = store.create(scope, input);
		expect(replay.id).toBe(first.id);
		expect(store.affectedResources(replay)).toEqual(expected);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
