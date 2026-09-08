import { expect, test } from "bun:test";
import {
	parseIdentityPolicy,
	parseLifeViewLimits,
} from "../src/world/life-validation.ts";

const profile = {
	agentId: "lina",
	profileRevision: 1,
	evolution: "adaptive" as const,
	lockedTraitIds: [],
	lockedHabitIds: [],
	lockedAttitudeIds: [],
};
const stamp = {
	digest: "a".repeat(64),
	receiptRevision: 1,
	profileRevision: 1,
	definitionRevision: 1,
	projectionRevision: 1,
};

test("identity v2 freezes typed personal values while v1 decoding preserves exact legacy bytes", () => {
	const legacy = { version: 1, profiles: [profile] };
	expect(JSON.stringify(parseIdentityPolicy(legacy))).toBe(
		JSON.stringify(legacy),
	);
	const current = {
		version: 2 as const,
		profiles: [
			{
				...profile,
				personalBehavior: {
					traits: [{ axisId: "curiosity", value: 3 }],
					habits: [{ habitId: "greeting", value: true }],
				},
				sourceStamp: stamp,
			},
		],
	};
	expect(parseIdentityPolicy(current)).toEqual(current);
	expect(
		parseIdentityPolicy({
			version: 2 as const,
			profiles: [{ ...profile, personalBehavior: null, sourceStamp: null }],
		}).version,
	).toBe(2);
});

test("identity v2 rejects leaked prose, mismatched source anchors, duplicate dimensions and unsupported versions", () => {
	const row = {
		...profile,
		personalBehavior: {
			traits: [{ axisId: "curiosity", value: 3 }],
			habits: [],
		},
		sourceStamp: stamp,
	};
	for (const invalid of [
		{ ...row, sourceStamp: null },
		{ ...row, sourceStamp: { ...stamp, profileRevision: 2 } },
		{
			...row,
			personalBehavior: { ...row.personalBehavior, secret: "PRIVATE" },
		},
		{
			...row,
			personalBehavior: {
				traits: [
					{ axisId: "curiosity", value: 1 },
					{ axisId: "curiosity", value: 2 },
				],
				habits: [],
			},
		},
	])
		expect(() =>
			parseIdentityPolicy({ version: 2 as const, profiles: [invalid] }),
		).toThrow();
	expect(() => parseIdentityPolicy({ version: 3, profiles: [] })).toThrow();
	expect(() => parseIdentityPolicy({ version: 1, profiles: [row] })).toThrow();
	expect(() =>
		parseLifeViewLimits({ version: 2 as const, maxChars: 10, maxRecords: 10 }),
	).toThrow();
});

test("publication author v2 preserves source stamps without changing legacy author decoding", async () => {
	const { parsePublicationAuthor } = await import(
		"../src/world/publication-record-fields.ts"
	);
	const legacy = {
		agentId: "lina",
		name: "Lina",
		voice: "warm",
		profileRevision: 1,
		behavior: { traits: [], habits: [], attitudes: [] },
	};
	expect(JSON.stringify(parsePublicationAuthor(legacy))).toBe(
		JSON.stringify(legacy),
	);
	const next = { version: 2 as const, ...legacy, sourceStamp: stamp };
	expect(parsePublicationAuthor(next)).toEqual(next);
	expect(() =>
		parsePublicationAuthor({
			...next,
			sourceStamp: { ...stamp, profileRevision: 2 },
		}),
	).toThrow();
	expect(() => parsePublicationAuthor({ ...next, version: 3 })).toThrow();
	expect(() =>
		parsePublicationAuthor({ ...legacy, sourceStamp: stamp }),
	).toThrow();
});

test("AgentStore initializes and restores the personal behavior owner alongside authored profiles", async () => {
	const { learnedFixture } = await import("./learned-source-fixture.ts");
	const { AgentStore } = await import("../src/agents/store.ts");
	const { join } = await import("node:path");
	const f = learnedFixture();
	const path = join(f.root, "agents.sqlite");
	let agents = new AgentStore(path);
	try {
		agents.create(f.profile);
		expect(agents.behavior.status("lina")).toEqual([]);
		agents.close();
		agents = new AgentStore(path);
		expect(agents.get("lina")?.profile).toBe("authored");
		expect(agents.behavior.status("lina")).toEqual([]);
	} finally {
		agents.close();
		f.close();
	}
});
