import { expect, test } from "bun:test";
import { z } from "zod";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("agent resource activity HTTP reaches LIFE and survives a fleet restart", async () => {
	const f = await fleetLifeFixture();
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${f.app.port}${path}`, {
			method,
			...(body
				? {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}
				: {}),
		});
	try {
		f.setup();
		const store = f.app.fleet.life.store;
		if (!(store instanceof WorldStore)) throw Error("Missing world owner");
		const { worldId, revision, ...config } = store.lifeConfig("test-world");
		store.setLifeConfig(worldId, revision, {
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "research",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		});
		const made = await call("/api/agents/lina/resources", "POST", {
			operationId: "doc",
			kind: "document",
			title: "Research",
			visibility: "shared",
			mediaType: "text/plain",
			text: "Source body",
		});
		expect(made.status).toBe(201);
		const doc = z.object({ id: z.string() }).parse(await made.json());
		const recorded = await call(
			"/api/agents/lina/resources/activities/record",
			"POST",
			{
				operationId: "record",
				activityId: "activity",
				worldId,
				participantAgentIds: ["lina"],
				activityKind: "search",
				outcome: "recorded",
				resourceId: doc.id,
				versionId: null,
				memoryId: null,
				quotes: [],
				fields: {
					categoryId: "research",
					outcome: "recorded",
					participantAgentIds: ["lina"],
					summary: "Research performed",
				},
				policyRevision: 1,
			},
		);
		expect(recorded.status).toBe(200);
		const step = await f.app.fleet.lifeRuntime.run(
			worldId,
			"resource-step",
			2,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		expect(step.source.work?.records[0]?.source.kind).toBe("resource_activity");
		expect(
			step.outcome?.commit.experiences.some((e) => e.agentId === "lina"),
		).toBe(true);
		await f.restart();
		const read = await call("/api/agents/lina/resources/activities/activity");
		expect(read.status).toBe(200);
		const replay = await f.app.fleet.lifeRuntime.run(
			worldId,
			"resource-step",
			2,
			new AbortController().signal,
		);
		expect(replay.id).toBe(step.id);
		expect(replay.outcome).toEqual(step.outcome);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});
