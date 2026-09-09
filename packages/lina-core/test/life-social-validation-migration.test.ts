import { expect, test } from "bun:test";
import { createEnsembleSocialEngine } from "../../lina-runtime/src/life/social/ensemble.ts";
import {
	continueInput,
	engineInput,
} from "../../lina-runtime/test/social-fixtures/engine-input.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import { migrateSocialCheckpoint } from "../src/world/social-migration.ts";
import { validateSocialResult } from "../src/world/social-result.ts";
import { required } from "./life-fixture.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

test.each([
	{ recent: 2, outcome: "rejected" },
	{ recent: 1, outcome: "accepted" },
])(
	"migrated predicate history with mostRecent=$recent produces $outcome",
	async ({ recent, outcome }) => {
		const oldPack = socialPack(),
			input = engineInput(oldPack),
			engine = createEnsembleSocialEngine();
		const result = await engine.resolve(input, new AbortController().signal);
		if (result.kind !== "advanced") throw Error("Expected checkpoint");
		const nextPack = structuredClone(oldPack);
		nextPack.version++;
		nextPack.world.version++;
		nextPack.life.revision++;
		nextPack.predicates.push({
			id: "mood",
			type: "boolean",
			direction: "undirected",
			initial: true,
			min: null,
			max: null,
		});
		nextPack.social.policies.push({
			predicateId: "mood",
			duration: null,
			visibility: { kind: "first" },
			resource: false,
			attitudeAxisId: null,
		});
		nextPack.variables.push({
			id: "season",
			type: "string",
			initial: "winter",
			min: null,
			max: null,
			knownTo: ["lina"],
		});
		required(
			nextPack.social.actions.find((a) => a.kind === "root"),
		).conditions = [
			{
				predicateId: "mood",
				first: { kind: "actor" },
				second: null,
				operator: "=",
				value: true,
				window: { mostRecent: recent, leastRecent: 2 },
			},
		];
		const migration = migrateSocialCheckpoint(
			result.checkpoint,
			oldPack,
			nextPack,
			{ worldRevision: 2, lifeRevision: 2, simulationTime: 1 },
		);
		expect(
			migration.checkpoint.data.predicateIntroductions.find(
				(i) => i.id === "mood",
			),
		).toEqual({ id: "mood", socialStep: 1, worldRevision: 2 });
		expect(
			migration.checkpoint.data.variableIntroductions.find(
				(i) => i.id === "season",
			),
		).toEqual({ id: "season", socialStep: 1, worldRevision: 2 });
		const next = continueInput(input, result);
		next.world.revision = 2;
		next.world.definition = nextPack.world;
		next.life.revision = 2;
		next.life.worldRevision = 2;
		next.life.definitionRevision = nextPack.life.revision;
		next.rulePack = compileSocialPack(nextPack);
		next.checkpoint = migration.checkpoint;
		next.life.checkpoint = migration.checkpoint;
		const before = lifeDigest(next),
			continued = await engine.resolve(next, new AbortController().signal);
		expect(continued.outcome).toBe(outcome);
		expect(validateSocialResult(next, continued)).toEqual(continued);
		expect(lifeDigest(next)).toBe(before);
		if (continued.kind !== "advanced") throw Error("Expected continuation");
		expect(continued.checkpoint.data.variables["season"]).toBe("winter");
	},
);
