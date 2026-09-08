import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createCodexLifeModel } from "../../lina-codex/src/life-model.ts";
import { lifeResponse } from "../../lina-codex/test/life-model-fixture.ts";
import type { LifeStep } from "../../lina-core/src/world/autonomy-types.ts";
import { emptyReflection } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
nativeTest(
	"owner HTTP step uses installed Codex/bwrap and the configured local Responses provider, persists and replays without inference",
	async () => {
		const bodies: Record<string, unknown>[] = [];
		const f = await fleetLifeFixture(
			{ createLifeModel: createCodexLifeModel },
			async (request) => {
				expect(request.method).toBe("POST");
				expect(new URL(request.url).pathname).toBe("/v1/responses");
				bodies.push((await request.json()) as Record<string, unknown>);
				const text =
					bodies.length === 1
						? "PRIVATE_NATIVE_DIRECTOR"
						: bodies.length === 2
							? JSON.stringify(socialIntent())
							: bodies.length === 3
								? JSON.stringify({
										intentId: "intent-1",
										agentId: "mira",
										decision: "accept",
									})
								: JSON.stringify(emptyReflection());
				return lifeResponse(text);
			},
		);
		try {
			f.setup(false);
			for (const id of ["lina", "mira", "sol"])
				f.app.fleet.agents.update(id, 1, {
					profile: `NATIVE_PROFILE_${id}_CANARY`,
				});
			expect(f.providerCalls).toBe(0);
			const url = () =>
				`http://127.0.0.1:${f.app.port}/api/life/worlds/test-world/step`;
			const post = () =>
				fetch(url(), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						idempotencyKey: "actual-native-http",
						expectedConfigRevision: 1,
					}),
				});
			const response = await post();
			expect(response.status).toBe(200);
			const step = (await response.json()) as LifeStep;
			expect(step.status).toBe("accepted");
			expect(bodies).toHaveLength(step.models.length);
			expect(bodies).toHaveLength(5);
			expect(new Set(step.models.map((row) => row.result?.threadId)).size).toBe(
				step.models.length,
			);
			for (const [index, row] of step.models.entries()) {
				expect(bodies[index]?.["model"]).toBe(row.prepared.request.model);
				expect(row.result).toMatchObject({
					upstreamAttempts: 1,
					usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
				});
				const wire = JSON.stringify(bodies[index]);
				for (const id of ["lina", "mira", "sol"]) {
					if (id === row.prepared.request.agentId)
						expect(wire).toContain(`NATIVE_PROFILE_${id}_CANARY`);
					else expect(wire).not.toContain(`NATIVE_PROFILE_${id}_CANARY`);
				}
				for (const absent of [
					"lina_work",
					"exec_command",
					"web_search",
					"image_generation",
					"mcp__",
					"memory_search",
					"UNSELECTED_METADATA_INSTRUCTIONS",
				])
					expect(wire).not.toContain(absent);
			}
			expect(f.app.fleet.opened("lina")).toBeUndefined();
			await f.restart();
			expect(await (await post()).json()).toEqual(step);
			expect(f.providerCalls).toBe(step.models.length);
		} finally {
			await f.close();
			const surviving = readdirSync("/proc").filter((pid) => {
				if (!/^\d+$/.test(pid)) return false;
				try {
					return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(f.root);
				} catch {
					return false;
				}
			});
			expect(surviving).toEqual([]);
		}
	},
	60000,
);
