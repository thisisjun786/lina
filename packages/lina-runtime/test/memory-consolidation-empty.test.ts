import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { CompanionMemory } from "../src/context/companion.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { companionRoutes } from "../src/fleet/companion-routes.ts";
import type { AgentFleet } from "../src/fleet/manager.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("HTTP retraction of the last premise stops obsolete consolidation wakes", async () => {
	const f = createRuntimeFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	let now = Date.UTC(2026, 8, 8);
	const wakes: number[] = [];
	let calls = 0;
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: (_callback, delay) => {
			wakes.push(delay);
			return () => {};
		},
	});
	memory.configure(
		async () =>
			JSON.stringify([
				{
					subject: "user",
					kind: "interest",
					key: "walking",
					text: "Likes walking",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "walking" }],
				},
			]),
		undefined,
		{
			consolidate: async () => {
				calls++;
				throw Error("injected failure");
			},
			policy: defaultEnginePolicy,
			modelSettingsRevision: () => 0,
		},
	);
	// Only route lookup is synthetic; the HTTP handler and memory owner are real.
	const fleet = {
		agents: { get: (id: string) => (id === "lina" ? { id } : undefined) },
		opened: () => ({ memory }),
	} as unknown as AgentFleet;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) =>
			(await companionRoutes(request, fleet, async () =>
				z.record(z.string(), z.unknown()).parse(await request.json()),
			)) ?? new Response("missing", { status: 404 }),
	});
	try {
		f.store.createRequest("r", "walking");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "walking",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(memory.status().consolidation?.state).toBe("failed");
		const record = memory.mind.state().records.find((r) => r.key === "walking");
		if (!record) throw Error("missing observation");
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/agents/lina/mind/retract`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: record.id,
					revision: memory.mind.currentRevision(),
				}),
			},
		);
		expect(response.status).toBe(200);
		now += 60000;
		wakes.length = 0;
		const before = calls;
		for (let i = 0; i < 6; i++) await memory.refresh();
		expect(memory.mind.reasoningCandidates()).toHaveLength(0);
		expect(wakes).toEqual([]);
		expect(calls).toBe(before);
		expect(memory.status().consolidation).toMatchObject({
			state: "committed",
			failed: 0,
			pending: 0,
			totalPages: 0,
			error: null,
			incomplete: false,
		});
		expect(
			memory.mind
				.reasoningJobs()
				.every((j) => j.state === "withheld" && j.error === "superseded"),
		).toBe(true);
	} finally {
		await server.stop(true);
		await memory.close();
		await f.close();
	}
});
