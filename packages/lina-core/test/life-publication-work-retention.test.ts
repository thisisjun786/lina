import { expect, test } from "bun:test";
import { parseLifeConfigInput } from "../src/world/authoring-request-validation.ts";
import { buildAutonomyOutcome } from "../src/world/autonomy-transition.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { stepWorkAncestry } from "../src/world/work-ancestry.ts";
import { workExperiences } from "../src/world/work-experience.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput } from "./life-work-fixture.ts";

test("publication-capable step v3 retains the complete v2 work experience and causal ancestry", () => {
	const f = autonomyStoreFixture();
	try {
		const { worldId, revision, ...config } = f.store.lifeConfig(
			f.request.worldId,
		);
		f.store.setLifeConfig(
			worldId,
			revision,
			parseLifeConfigInput({
				...config,
				version: 2,
				work: {
					rules: [
						{
							id: "work",
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
		f.request.expectedConfigRevision++;
		f.store.admitWorkInput(workInput(worldId));
		const prepared = f.store.prepareLifeStep(f.request, () => 1),
			v3 = f.store.finishLifeStep(prepared.lease, prepared.id, f.clock());
		expect(v3.version).toBe(3);
		// Compare the old pure v2 envelope with the actual new v3 producer.
		const v2 = { ...v3, version: 2 as const, source: { ...v3.source } };
		delete v2.source.publication;
		delete v2.source.publicationAncestry;
		delete v2.source.publicationBudget;
		const expectedExperiences = workExperiences(v2),
			expectedAncestry = stepWorkAncestry(v2);
		expect(expectedExperiences).toHaveLength(1);
		expect(
			expectedAncestry.some((row) => row.subject.kind === "world_event"),
		).toBe(true);
		expect(workExperiences(v3)).toEqual(expectedExperiences);
		expect(stepWorkAncestry(v3)).toEqual(expectedAncestry);
		expect(buildAutonomyOutcome(v3, null)).toEqual(
			buildAutonomyOutcome(v2, null),
		);
		const actorV2 = { ...v2, decision: { ...v2.decision, agentId: "lina" } },
			actorV3 = { ...v3, decision: { ...v3.decision, agentId: "lina" } };
		const prompt = buildLifeModelInput(actorV2, "director", "lina");
		expect(prompt.input).toContain("sharedPersona");
		expect(buildLifeModelInput(actorV3, "director", "lina")).toEqual(prompt);
	} finally {
		f.close();
	}
});
