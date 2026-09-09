import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	migrateSocialCheckpoint,
	validateSocialCheckpoint,
} from "../src/world/social.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../src/world/social-codec.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import { parseEnsembleCheckpoint } from "../src/world/social-validation.ts";
import { required } from "./life-fixture.ts";
import { socialPack } from "./life-social-pack-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";

test("rejects corrupt history ownership even with a recomputed digest", () => {
	const checkpoint = checkpointFixture();
	checkpoint.data.state.history = encodeSocialValue([
		[],
		[
			{
				category: "p_7472757374",
				type: "value",
				first: "unknown",
				second: "mira",
				value: 1,
				id: 4,
				timeHappened: 1,
			},
		],
	]);
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	expect(() => parseEnsembleCheckpoint(checkpoint)).toThrow();
});
test("rejects arbitrary tagged cache records even with valid checksums", () => {
	const checkpoint = checkpointFixture();
	checkpoint.data.state.volitionCache = encodeSocialValue({
		main: {
			lina: {
				mira: [
					{
						category: "p_7472757374",
						type: "value",
						first: "lina",
						second: "mira",
						weight: 1,
						intentType: true,
						englishInfluences: [],
						arbitrary: { state: "hidden" },
					},
				],
			},
		},
	});
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	expect(() => parseEnsembleCheckpoint(checkpoint)).toThrow();
});
test("checks complete schema, values, introductions and historical counters", () => {
	const compiled = compileSocialPack(socialPack());
	validateSocialCheckpoint(checkpointFixture(), compiled);
	for (const kind of ["value", "introduction", "variable", "counter"]) {
		const checkpoint = checkpointFixture();
		if (kind === "value")
			checkpoint.data.state.history = encodeSocialValue([
				[],
				[
					{
						category: "p_7472757374",
						type: "value",
						first: "lina",
						second: "mira",
						value: 50,
						id: 4,
						timeHappened: 1,
					},
				],
			]);
		if (kind === "introduction") checkpoint.data.predicateIntroductions.pop();
		if (kind === "variable") checkpoint.data.variables["count"] = 100;
		if (kind === "counter")
			checkpoint.data.state.iterators["socialRecords"] = 3;
		checkpoint.dataDigest = lifeDigest(checkpoint.data);
		expect(() => validateSocialCheckpoint(checkpoint, compiled)).toThrow();
	}
});
test("background-only migration preserves exact history, cache, counters and random state", () => {
	const old = socialPack(),
		next = socialPack(),
		checkpoint = checkpointFixture();
	next.version = 2;
	next.world.version = 2;
	next.background.authoredText = "New scenery";
	const before = structuredClone(checkpoint);
	const result = migrateSocialCheckpoint(checkpoint, old, next, {
		worldRevision: 2,
		lifeRevision: 2,
		simulationTime: 9,
	});
	expect(checkpoint).toEqual(before);
	expect(result.checkpoint.data.state).toEqual(before.data.state);
	expect(result.checkpoint.data.rng).toEqual(before.data.rng);
	expect(result.checkpoint.data.variables).toEqual(before.data.variables);
	expect(result.migration.operations).toEqual([]);
	expect(result.checkpoint.data.worldRevision).toBe(2);
	expect(result.migration.previousCheckpointDigest).toBe(lifeDigest(before));
	expect(result.migration.nextCheckpointDigest).toBe(
		lifeDigest(result.checkpoint),
	);
});
test("additions start at the boundary, retirement retains facts, changed rules invalidate caches", () => {
	const old = socialPack(),
		next = socialPack(),
		checkpoint = checkpointFixture();
	next.version = 2;
	next.world.version = 2;
	required(next.roles[2]).status = "retired";
	next.predicates.push({
		id: "mood",
		type: "boolean",
		direction: "undirected",
		initial: true,
		min: null,
		max: null,
	});
	next.social.policies.push({
		predicateId: "mood",
		duration: null,
		visibility: { kind: "first" },
		resource: false,
		attitudeAxisId: null,
	});
	checkpoint.data.state.noRepeat = { fixture: 9 };
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	const result = migrateSocialCheckpoint(checkpoint, old, next, {
		worldRevision: 2,
		lifeRevision: 2,
		simulationTime: 9,
	});
	expect(
		result.checkpoint.data.predicateIntroductions.find((i) => i.id === "mood"),
	).toEqual({ id: "mood", socialStep: 1, worldRevision: 2 });
	expect(result.checkpoint.data.state.offstage).toEqual(["sol"]);
	expect(result.checkpoint.data.state.eliminated).toEqual([]);
	expect(result.checkpoint.data.state.noRepeat).toEqual({ fixture: 9 });
	expect(result.checkpoint.data.state.iterators["socialRecords"]).toBe(7);
	const history = decodeSocialValue(
		result.checkpoint.data.state.history,
	) as unknown[][];
	expect(history[0]).toEqual([]);
	expect(history[1]?.[0]).toEqual(
		(decodeSocialValue(checkpoint.data.state.history) as unknown[][])[1]?.[0],
	);
	expect(history[1]?.length).toBe(4);
	validateSocialCheckpoint(result.checkpoint, compileSocialPack(next));
});
test("incompatible migration rejects without resetting the source", () => {
	const checkpoint = checkpointFixture(),
		before = structuredClone(checkpoint);
	const next = socialPack();
	next.version = 2;
	next.world.version = 2;
	required(next.predicates[1]).initial = 7;
	expect(() =>
		migrateSocialCheckpoint(checkpoint, socialPack(), next, {
			worldRevision: 2,
			lifeRevision: 2,
			simulationTime: 9,
		}),
	).toThrow();
	expect(checkpoint).toEqual(before);
});
test("additive variables record introduction and keep previous live values", () => {
	const checkpoint = checkpointFixture(),
		next = socialPack();
	checkpoint.data.variables["count"] = 8;
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	next.version = 2;
	next.world.version = 2;
	next.variables.push({
		id: "season",
		type: "string",
		initial: "winter",
		min: null,
		max: null,
		knownTo: ["lina"],
	});
	const result = migrateSocialCheckpoint(checkpoint, socialPack(), next, {
		worldRevision: 2,
		lifeRevision: 2,
		simulationTime: 9,
	});
	expect(result.checkpoint.data.variables["count"]).toBe(8);
	expect(result.checkpoint.data.variables["season"]).toBe("winter");
	expect(
		result.checkpoint.data.variableIntroductions.find((i) => i.id === "season"),
	).toEqual({ id: "season", socialStep: 1, worldRevision: 2 });
	expect(result.migration.operations).toContainEqual({
		kind: "variable_added",
		id: "season",
	});
});
