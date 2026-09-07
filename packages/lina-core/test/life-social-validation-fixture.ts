import { lifeDigest } from "../src/world/life-json.ts";
import { encodeSocialValue } from "../src/world/social-codec.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import type { EnsembleCheckpoint } from "../src/world/social-types.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

export function checkpointFixture(): EnsembleCheckpoint {
	const pack = socialPack(),
		compiled = compileSocialPack(pack);
	const data: EnsembleCheckpoint["data"] = {
		worldId: pack.worldId,
		packVersion: 1,
		worldRevision: 1,
		lifeRevision: 1,
		simulationTime: 1,
		compilerRevision: 1,
		schemaDigest: compiled.schemaDigest,
		actionDigest: compiled.actionDigest,
		cast: ["lina", "mira", "sol"],
		variables: { count: 1, flag: false, secret: "hidden-value" },
		predicateIntroductions: ["coins", "trust"].map((id) => ({
			id,
			socialStep: 0,
			worldRevision: 0,
		})),
		agentIntroductions: ["lina", "mira", "sol"].map((id) => ({
			id,
			socialStep: 0,
			worldRevision: 0,
		})),
		variableIntroductions: ["count", "flag", "secret"].map((id) => ({
			id,
			socialStep: 0,
			worldRevision: 0,
		})),
		state: {
			history: encodeSocialValue([
				[],
				[
					{
						category: "p_7472757374",
						type: "value",
						first: "lina",
						second: "mira",
						value: 1,
						id: 4,
						timeHappened: 1,
						duration: undefined,
						origin: undefined,
					},
				],
			]),
			step: 1,
			offstage: [],
			eliminated: [],
			iterators: { socialRecords: 4, rules: 0, actions: 2 },
			noRepeat: {},
			volitionCache: encodeSocialValue({}),
			cachePositions: {},
		},
		rng: { algorithm: "lcg32-v1", seed: 42, state: 1083814273, drawIndex: 1 },
	};
	return {
		version: 1,
		engineId: "ensemble",
		engineRevision: "8b74bdec-lina-1",
		encodingVersion: 1,
		ruleDigest: compiled.ruleDigest,
		data,
		dataDigest: lifeDigest(data),
	};
}
