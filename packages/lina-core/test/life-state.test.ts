import { describe, expect, test } from "bun:test";
import { initialSnapshot, transition } from "../src/world/transition.ts";
import {
	identityPolicy,
	lifeCommit,
	lifeDefinition,
	required,
	socialCommit,
} from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

// Dynamic imports keep the missing first-unit implementation visible as named REDs.
const validation = () => import("../src/world/life-validation.ts");
const engine = () => import("../src/world/life-transition.ts");

describe("LIFE pure state", () => {
	test("strict versions, fields, numbers and authored bounds reject", async () => {
		const { parseLifeDefinition } = await validation();
		for (const patch of [
			{ version: 2 },
			{ extra: true },
			{ revision: 1.5 },
			{ revision: Number.MAX_SAFE_INTEGER + 1 },
			{ traits: [{ id: "axis", label: "Axis", min: 2, max: 1, initial: 1 }] },
			{ participants: ["lina", "lina"] },
		])
			expect(() =>
				parseLifeDefinition({ ...lifeDefinition(), ...patch }),
			).toThrow();
		for (const invalid of [
			NaN,
			Infinity,
			-Infinity,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			const value = lifeDefinition();
			value.traits[0] = {
				id: "axis",
				label: "Axis",
				min: -2,
				max: 2,
				initial: invalid,
			};
			expect(() => parseLifeDefinition(value)).toThrow();
		}
	});
	test("normalization is detached and canonical set ordering is stable", async () => {
		const { parseLifeDefinition, canonicalLifeJson, lifeDigest } =
			await validation();
		const source = lifeDefinition();
		source.participants.reverse();
		required(source.traits[0]).initial = -0;
		const parsed = parseLifeDefinition(source);
		expect(parsed.participants).toEqual(["lina", "mira", "sol"]);
		expect(Object.is(required(parsed.traits[0]).initial, -0)).toBe(false);
		expect(lifeDigest(parsed)).toBe(
			lifeDigest(parseLifeDefinition(lifeDefinition())),
		);
		expect(canonicalLifeJson({ b: 1, a: -0 })).toBe('{"a":0,"b":1}');
		expect(lifeDigest(null)).toBe(
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		);
		parsed.participants.pop();
		expect(source.participants).toHaveLength(3);
	});
	test("empty baseline preserves legacy JSON and invents no experiences", async () => {
		const { initialLifeState } = await engine();
		const world = initialSnapshot(worldDefinition());
		const before = JSON.stringify(world);
		const state = initialLifeState(world, lifeDefinition());
		expect(state.revision).toBe(0);
		expect(state.worldRevision).toBe(0);
		expect(state.claims).toEqual([]);
		expect(state.experiences).toEqual([]);
		expect(state.growthHistory).toEqual([]);
		expect(state.checkpoint.engineId).toBe("empty");
		expect(JSON.stringify(world)).toBe(before);
	});
	test("manual and locked identity reject growth without touching prior state", async () => {
		const { initialLifeState, applyLifeTransition } = await engine();
		const world = initialSnapshot(worldDefinition());
		const def = lifeDefinition();
		const before = initialLifeState(world, def);
		const commit = socialCommit();
		const nextWorld = transition(world, commit.world);
		for (const locked of ["manual", "axis"] as const) {
			const identity = identityPolicy();
			if (locked === "manual")
				required(identity.profiles[0]).evolution = "manual";
			else required(identity.profiles[0]).lockedTraitIds = ["axis"];
			expect(() =>
				applyLifeTransition(before, world, nextWorld, def, commit, identity),
			).toThrow();
		}
		expect(before.experiences).toEqual([]);
		expect(before.revision).toBe(0);
	});
	test("new experience, belief and asymmetric growth apply as one detached transition", async () => {
		const { initialLifeState, applyLifeTransition } = await engine();
		const world = initialSnapshot(worldDefinition());
		const def = lifeDefinition();
		const commit = socialCommit();
		const before = initialLifeState(world, def);
		const next = applyLifeTransition(
			before,
			world,
			transition(world, commit.world),
			def,
			commit,
			identityPolicy(),
		);
		expect(next.revision).toBe(1);
		expect(next.experiences.map((x) => x.id)).toEqual(["told", "witness"]);
		expect(next.beliefs[0]?.stance).toBe("believes");
		expect(
			next.attitudes.find(
				(x) => x.fromAgentId === "lina" && x.toAgentId === "mira",
			)?.value,
		).toBe(-1);
		expect(
			next.attitudes.find(
				(x) => x.fromAgentId === "mira" && x.toAgentId === "lina",
			)?.value,
		).toBe(0);
		expect(next.growthHistory).toHaveLength(2);
		required(next.experiences[0]).claims.pop();
		expect(commit.experiences[0]?.claims).toHaveLength(1);
		expect(before.experiences).toEqual([]);
	});
	test("unknown engine, corrupt digest, cross-world/future refs, duplicates and quiet-tick growth reject", async () => {
		const { parseLifeCommit } = await validation();
		const { initialLifeState, applyLifeTransition } = await engine();
		const def = lifeDefinition();
		const world = initialSnapshot(worldDefinition());
		const state = initialLifeState(world, def);
		expect(() =>
			parseLifeCommit({
				...lifeCommit(),
				checkpoint: { ...lifeCommit().checkpoint, engineId: "ensemble" },
			}),
		).toThrow();
		expect(() =>
			parseLifeCommit({
				...lifeCommit(),
				checkpoint: { ...lifeCommit().checkpoint, dataDigest: "0".repeat(64) },
			}),
		).toThrow();
		for (const ref of [
			"test-world:2",
			"other:1",
			"test-world:9007199254740992",
		]) {
			const c = socialCommit();
			required(c.experiences[0]).eventId = ref;
			expect(() =>
				applyLifeTransition(
					state,
					world,
					transition(world, c.world),
					def,
					c,
					identityPolicy(),
				),
			).toThrow();
		}
		const duplicate = socialCommit();
		duplicate.experiences.push(required(duplicate.experiences[0]));
		expect(() => parseLifeCommit(duplicate)).toThrow();
		const tick = lifeCommit({
			world: {
				...lifeCommit().world,
				kind: "tick",
				sceneId: null,
				actorIds: [],
				audience: [],
				summary: "",
				facts: [],
				moves: [],
			},
			growth: socialCommit().growth,
		});
		expect(() =>
			applyLifeTransition(
				state,
				world,
				transition(world, tick.world),
				def,
				tick,
				identityPolicy(),
			),
		).toThrow();
	});
});

test("belief and experience references cannot grant statement knowledge", async () => {
	const { initialLifeState, applyLifeTransition } = await engine();
	const world = initialSnapshot(worldDefinition());
	const def = lifeDefinition();
	const before = initialLifeState(world, def);
	for (const c of [socialCommit(), socialCommit()]) {
		if (c === undefined) throw Error("fixture");
		required(c.claims[0]).disclosure.knowers = ["mira"];
		expect(() =>
			applyLifeTransition(
				before,
				world,
				transition(world, c.world),
				def,
				c,
				identityPolicy(),
			),
		).toThrow("knowledge");
	}
	const fact = socialCommit();
	required(fact.experiences[0]).claims = [
		{ kind: "world_fact", id: "whisper" },
	];
	fact.beliefs = [];
	expect(() =>
		applyLifeTransition(
			before,
			world,
			transition(world, fact.world),
			def,
			fact,
			identityPolicy(),
		),
	).toThrow("knowledge");
});

test("canonical JSON rejects executable, non-JSON and oversized primitive payloads", async () => {
	const { canonicalLifeJson, parseLifeDefinition } = await validation();
	const accessor = Object.defineProperty({}, "payload", {
		enumerable: true,
		get() {
			throw Error("EXECUTED");
		},
	});
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	for (const bad of [
		undefined,
		NaN,
		BigInt(1),
		new Date(),
		new Array(2),
		cycle,
		accessor,
		{ a: undefined },
		{ [Symbol("hidden")]: 1 },
	])
		expect(() => canonicalLifeJson(bad)).toThrow();
	expect(() => {
		canonicalLifeJson("x".repeat(1_000_001));
	}).toThrow("capacity");
	const hidden = Object.defineProperty(lifeDefinition(), "extension", {
		value: "hidden",
		enumerable: false,
	});
	expect(() => parseLifeDefinition(hidden)).toThrow();
});
test("independent state parsing rejects malformed local references and future origins", async () => {
	const { parseLifeState } = await validation();
	const { initialLifeState, applyLifeTransition } = await engine();
	const def = lifeDefinition();
	const beforeWorld = initialSnapshot(worldDefinition());
	const commit = socialCommit();
	const world = transition(beforeWorld, commit.world);
	const state = applyLifeTransition(
		initialLifeState(beforeWorld, def),
		beforeWorld,
		world,
		def,
		commit,
		identityPolicy(),
	);
	const future = structuredClone(state);
	required(future.claims[0]).sourceEventId = "test-world:2";
	expect(() => parseLifeState(future)).toThrow();
	const missing = structuredClone(state);
	required(missing.experiences[0]).claims = [
		{ kind: "life_claim", id: "missing" },
	];
	expect(() => parseLifeState(missing)).toThrow();
	const stolen = structuredClone(state);
	required(stolen.beliefs[0]).experienceIds = ["witness"];
	expect(() => parseLifeState(stolen)).toThrow();
});
test("input, intent and binding schemas are strict, digest-bound and detached", async () => {
	const {
		parseLifeInput,
		parseLifeCommit,
		parseWorldBinding,
		parseIdentityPolicy,
		lifeDigest,
	} = await validation();
	const source = {
		kind: "application" as const,
		sourceId: "fixture",
		text: "Synthetic admission",
	};
	const input = {
		version: 1 as const,
		worldId: "test-world",
		id: "input",
		sourceRevision: 0,
		source,
		payloadDigest: lifeDigest(source),
		consumedLifeRevision: null,
	};
	expect(parseLifeInput(input)).toEqual(input);
	expect(() =>
		parseLifeInput({ ...input, source: { ...source, text: "changed" } }),
	).toThrow("digest");
	expect(() => parseLifeInput({ ...input, consumedLifeRevision: 0 })).toThrow();
	const payload = {
		kind: "publication_candidate",
		eventId: "test-world:1",
	} as const;
	const commit = lifeCommit({
		effects: [
			{
				version: 1,
				worldId: "test-world",
				id: "candidate",
				lifeRevision: 1,
				payload,
				payloadDigest: lifeDigest(payload),
			},
		],
	});
	expect(parseLifeCommit(commit).effects).toEqual(commit.effects);
	expect(() =>
		parseLifeCommit({
			...commit,
			effects: [{ ...commit.effects[0], payloadDigest: "a".repeat(64) }],
		}),
	).toThrow("digest");
	expect(() =>
		parseWorldBinding({
			version: 1,
			agentId: "lina",
			worldId: null,
			revision: 1,
			projectionPolicyRevision: 1,
		}),
	).toThrow();
	expect(() =>
		parseWorldBinding({
			version: 1,
			agentId: "lina",
			worldId: "test-world",
			revision: 1,
			projectionPolicyRevision: 0,
		}),
	).toThrow();
	const identity = identityPolicy();
	required(identity.profiles[0]).lockedTraitIds = ["axis", "axis"];
	expect(() => parseIdentityPolicy(identity)).toThrow();
});
test("supersession keeps original records and cross-agent evidence rejects", async () => {
	const { initialLifeState, applyLifeTransition, validateLifeState } =
		await engine();
	const def = lifeDefinition();
	const original = initialSnapshot(worldDefinition());
	const first = socialCommit();
	const world = transition(original, first.world);
	const state = applyLifeTransition(
		initialLifeState(original, def),
		original,
		world,
		def,
		first,
		identityPolicy(),
	);
	const second = lifeCommit({
		world: {
			...first.world,
			idempotencyKey: "second",
			expectedRevision: 1,
			simulationTime: 2,
			facts: [],
		},
		expectedLifeRevision: 1,
		beliefs: [
			{
				...required(first.beliefs[0]),
				id: "belief-2",
				stance: "disbelieves",
				supersedes: "belief-a",
			},
		],
		growth: [
			{
				kind: "habit",
				agentId: "lina",
				habitId: "habit",
				previous: false,
				next: true,
				evidenceIds: ["told"],
			},
		],
	});
	const nextWorld = transition(world, second.world);
	const next = applyLifeTransition(
		state,
		world,
		nextWorld,
		def,
		second,
		identityPolicy(),
	);
	expect(next.beliefs.map((x) => x.id)).toEqual(["belief-a", "belief-2"]);
	expect(next.habits.find((x) => x.agentId === "lina")?.value).toBe(true);
	expect(() => validateLifeState(next, nextWorld, def)).not.toThrow();
	const corrupted = structuredClone(next);
	required(corrupted.traits[0]).value = 2;
	expect(() => validateLifeState(corrupted, nextWorld, def)).toThrow("history");
	required(second.growth[0]).evidenceIds = ["witness"];
	expect(() =>
		applyLifeTransition(state, world, nextWorld, def, second, identityPolicy()),
	).toThrow("evidence");
});
test("empty quiet tick advances only revisions/checkpoint and accepts baseline at a prior world revision", async () => {
	const { initialLifeState, applyLifeTransition } = await engine();
	const def = lifeDefinition();
	const beforeWorld = transition(
		initialSnapshot(worldDefinition()),
		lifeCommit().world,
	);
	const baseline = initialLifeState(beforeWorld, def);
	const c = lifeCommit({
		expectedLifeRevision: 0,
		world: {
			...lifeCommit().world,
			expectedRevision: 1,
			idempotencyKey: "quiet",
			simulationTime: 2,
			kind: "tick",
			sceneId: null,
			actorIds: [],
			audience: [],
			summary: "",
			facts: [],
			moves: [],
		},
	});
	const after = applyLifeTransition(
		baseline,
		beforeWorld,
		transition(beforeWorld, c.world),
		def,
		c,
		identityPolicy(),
	);
	expect(after.baseWorldRevision).toBe(1);
	expect(after.revision).toBe(1);
	expect(after.worldRevision).toBe(2);
	expect(after.experiences).toEqual([]);
	expect(after.growthHistory).toEqual([]);
});

test("historical experience cannot acquire a fact created by a later event", async () => {
	const { initialLifeState, applyLifeTransition } = await engine();
	const def = lifeDefinition();
	const initialWorld = initialSnapshot(worldDefinition());
	const first = lifeCommit();
	const world = transition(initialWorld, first.world);
	const state = applyLifeTransition(
		initialLifeState(initialWorld, def),
		initialWorld,
		world,
		def,
		first,
		identityPolicy(),
	);
	const next = lifeCommit({
		expectedLifeRevision: 1,
		world: {
			...first.world,
			expectedRevision: 1,
			idempotencyKey: "later",
			simulationTime: 2,
			facts: [
				{
					id: "later-fact",
					text: "Only became known later",
					knownTo: ["lina"],
				},
			],
		},
		experiences: [
			{
				id: "backdated",
				agentId: "lina",
				eventId: "test-world:1",
				simulationTime: 1,
				channel: "told",
				claims: [{ kind: "world_fact", id: "later-fact" }],
			},
		],
	});
	expect(() => {
		applyLifeTransition(
			state,
			world,
			transition(world, next.world),
			def,
			next,
			identityPolicy(),
		);
	}).toThrow("future");
});
test("baseline cannot carry invented LIFE knowledge and authored dimensions respect storage capacity", async () => {
	const { parseLifeState } = await validation();
	const { initialLifeState } = await engine();
	const world = transition(
		initialSnapshot(worldDefinition()),
		lifeCommit().world,
	);
	const baseline = initialLifeState(world, lifeDefinition());
	baseline.claims = socialCommit().claims;
	expect(() => {
		parseLifeState(baseline);
	}).toThrow("baseline");
	const def = lifeDefinition();
	def.participants = Array.from({ length: 65 }, (_, i) => `agent-${i}`);
	world.definition.agents = def.participants;
	expect(() => initialLifeState(world, def)).toThrow("capacity");
});
test("growth rejects unknown axes, bounds, stale previous values and forged evidence", async () => {
	const { initialLifeState, applyLifeTransition } = await engine();
	const def = lifeDefinition();
	const world = initialSnapshot(worldDefinition());
	const before = initialLifeState(world, def);
	const variants = [
		{
			kind: "trait",
			agentId: "lina",
			axisId: "unknown",
			previous: 0,
			next: 1,
			evidenceIds: ["told"],
		},
		{
			kind: "trait",
			agentId: "lina",
			axisId: "axis",
			previous: 0,
			next: 3,
			evidenceIds: ["told"],
		},
		{
			kind: "trait",
			agentId: "lina",
			axisId: "axis",
			previous: 1,
			next: 2,
			evidenceIds: ["told"],
		},
		{
			kind: "trait",
			agentId: "lina",
			axisId: "axis",
			previous: 0,
			next: 1,
			evidenceIds: ["missing"],
		},
		{
			kind: "attitude",
			fromAgentId: "lina",
			toAgentId: "lina",
			axisId: "relation",
			previous: 0,
			next: 1,
			evidenceIds: ["told"],
		},
	] as const;
	const { parseLifeCommit } = await validation();
	for (const growth of variants) {
		const commit = parseLifeCommit({ ...socialCommit(), growth: [growth] });
		expect(() => {
			applyLifeTransition(
				before,
				world,
				transition(world, commit.world),
				def,
				commit,
				identityPolicy(),
			);
		}).toThrow();
	}
	expect(before.growthHistory).toEqual([]);
});
