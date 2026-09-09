import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { resourceRoutes } from "../src/fleet/resource-routes.ts";
import { FleetResources } from "../src/fleet/resource-runtime.ts";

for (const unsupported of [false, true]) {
	test(`overlapping HTTP writes converge with unsupported child=${unsupported}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "lina-overview-order-"));
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const frames = z.object({
			sources: z.array(z.object({ text: z.string().nullable() })),
		});
		const inputs: z.infer<typeof frames>[] = [];
		let calls = 0;
		const owner = new FleetResources({
			root,
			limits: {
				maxFileBytes: 8192,
				maxCatalogBytes: 32768,
				maxExtractionBytes: 8192,
			},
			services: () => ({
				estimator: conservativeEstimator,
				estimateText: conservativeEstimator.text,
				estimateMessages: conservativeEstimator.messages,
				systemTokens: 0,
				contextWindow: 32768,
				reserveTokens: 1024,
				summarize: async () => "",
				prepare: () => {
					throw Error("unused");
				},
				resourceInputOverhead: () => 20,
				summarizeResource: async (text, signal, before) => {
					before?.();
					const n = ++calls;
					inputs.push(frames.parse(JSON.parse(text)));
					if (n === 1) {
						entered.resolve();
						await release.promise;
					}
					signal.throwIfAborted();
					return n === 1 ? "OLD_RESULT" : `RESULT_${n}`;
				},
			}),
			policy: defaultEnginePolicy,
			validAgent: (id) => id === "a",
			assertInstallation: () => {},
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) =>
				(await resourceRoutes(request, {
					store: owner.engine.store,
					scope: () => owner.scope("a"),
					onStored: (r) => owner.scheduleStored("a", r),
				})) ?? new Response("missing", { status: 404 }),
		});
		const base = `http://127.0.0.1:${server.port}/api/resources`;
		const create = async (input: unknown) => {
			const response = await fetch(base, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			});
			expect(response.status).toBe(201);
			return z.object({ id: z.string() }).parse(await response.json());
		};
		const read = async (id: string) => {
			const response = await fetch(`${base}/${id}/content?level=overview`);
			expect(response.status).toBe(200);
			return z
				.object({
					text: z.string().nullable(),
					complete: z.boolean(),
					status: z.string(),
				})
				.parse(await response.json());
		};
		try {
			const folder = await create({
				operationId: "folder",
				kind: "collection",
				title: "folder",
				visibility: "private",
			});
			await entered.promise;
			const original = owner.engine.store.indexing.list(
				owner.scope("a"),
				folder.id,
			)[0];
			if (!original) throw Error("missing overview");
			const docs = [];
			for (let i = 0; i < 2; i++)
				docs.push(
					await create({
						operationId: `child${i}`,
						kind: "document",
						title: `child${i}`,
						parentId: folder.id,
						visibility: "private",
						mediaType:
							unsupported && i === 1
								? "application/octet-stream"
								: "text/plain",
						text: `CHILD_${i}`,
					}),
				);
			release.resolve();
			await owner.drain();
			const overview = await read(folder.id);
			expect(overview.status).toBe("ready");
			expect(overview.complete).toBe(!unsupported);
			expect(overview.text).not.toBe("OLD_RESULT");
			expect(
				owner.engine.store.indexing.get(owner.scope("a"), original.id).state,
			).toBe("failed");
			const final = inputs.find((input) => input.sources.length === 3);
			expect(final).toBeDefined();
			const texts = final?.sources.map((source) => source.text);
			expect(texts).toContain("CHILD_0");
			if (!unsupported) expect(texts).toContain("CHILD_1");
			const secondDocument = docs[1];
			if (!secondDocument) throw Error("missing second document");
			const second = owner.engine.store.indexing
				.list(owner.scope("a"), secondDocument.id)
				.find((job) => job.kind === "extract");
			expect(second?.state).toBe(unsupported ? "unavailable" : "ready");
			expect(calls).toBe(unsupported ? 3 : 4);
			const before = calls;
			owner.schedule("a", folder.id);
			await owner.drain();
			expect(calls).toBe(before);
			expect((await read(folder.id)).complete).toBe(!unsupported);
		} finally {
			release.resolve();
			await server.stop(true);
			await owner.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
