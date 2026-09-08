import { expect, test } from "bun:test";
import { createLifeModelGateway } from "../../lina-codex/src/life-model-gateway.ts";
import { parseLifeConfigInput } from "../../lina-core/src/world/authoring-request-validation.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { workInput } from "../../lina-core/test/life-work-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("destination work restriction fences the final gateway even when source authority and model route remain valid", async () => {
	const f = await fleetLifeFixture(
		{},
		() => new Response("UNEXPECTED_UPSTREAM", { status: 200 }),
	);
	let gate: ReturnType<typeof createLifeModelGateway> | undefined;
	try {
		f.setup(false);
		const store = f.app.fleet.life.store;
		if (!(store instanceof WorldStore)) throw Error("Missing store");
		const { worldId, revision, ...config } = store.lifeConfig("test-world");
		store.setLifeConfig(
			worldId,
			revision,
			parseLifeConfigInput({
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
			}),
		);
		// A trusted synthetic source stays valid; this isolates destination revocation.
		f.app.tasks.workDeliveryCurrent = () => true;
		f.app.tasks.workProofCurrent = () => true;
		store.admitWorkInput(workInput(worldId));
		const model = f.models[0],
			selection = f.selections[0];
		if (!model || !selection) throw Error("Missing model");
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		model.onComplete = async (prepared) => {
			const request = prepared.request;
			gate = createLifeModelGateway({
				credential: undefined,
				baseUrl: selection.selection(request).connection.baseUrl,
				request,
				signal: new AbortController().signal,
				beforeOutbound: () => {
					selection.selection(request);
				},
				observed() {},
			});
			entered.resolve();
			await release.promise;
			return model.result(prepared);
		};
		const pending = f.app.fleet.lifeRuntime.run(
			worldId,
			"restricted-gateway",
			2,
			new AbortController().signal,
		);
		await entered.promise;
		try {
			const old = store.lifeConfig(worldId);
			store.setLifeConfig(
				worldId,
				old.revision,
				parseLifeConfigInput({ ...config, version: 2, work: null }),
			);
			const active = model.requests[0];
			if (!gate || !active) throw Error("Missing gateway");
			expect(active.input).toContain("Finished research");
			const response = await fetch(`${gate.baseUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${gate.nonce}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: active.model,
					tools: [],
					instructions: active.systemPrompt,
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: active.input }],
						},
					],
					stream: true,
				}),
			});
			expect(response.status).toBe(400);
			expect(gate.upstreamAttempts).toBe(0);
			expect(f.providerCalls).toBe(0);
		} finally {
			release.resolve();
			await pending;
		}
	} finally {
		await gate?.close();
		await f.close();
	}
});
