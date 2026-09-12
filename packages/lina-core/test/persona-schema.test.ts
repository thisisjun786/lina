import { expect, test } from "bun:test";
import type {
	DimensionSource,
	NeuralProjectionRef,
	PersonaDimension,
	PersonaDimensionKind,
	PersonaDimensionRef,
	PersonaSchema,
} from "../src/agents/index.ts";
import {
	behaviorFingerprint,
	DIMENSION_SOURCES,
	parsePersonaSchema,
	personaSchemaDigest,
	personaSchemaFromLifeDefinition,
} from "../src/agents/index.ts";

const HASH = "a".repeat(64);
const PINNED_BEHAVIOR_FINGERPRINT =
	"4525f17c17ca4c725ba9e4a8490afe2ed3e2952164cdbf9962e6e46b3e785ecd";
const GOLDEN_PERSONA_SCHEMA_DIGEST =
	"fbb3dddb51803bb05996cabe7f2182b305ceaed0127f95f7d19809686b447a37";
const GOLDEN_PERSONA_SCHEMA_JSON = `{"schemaVersion":1,"agentId":"lina","revision":1,"sourceDefinition":{"worldId":"world","definitionRevision":1,"definitionDigest":"${HASH}"},"sourceIdentity":{"profileRevision":1},"dimensions":[{"id":"warmth","kind":"trait","label":"Warmth","source":"reflection","range":{"min":0,"max":10},"initial":5,"locked":false,"originAxisId":"warmth"},{"id":"tea","kind":"habit","label":"Drinks tea","source":"reflection","range":null,"initial":true,"locked":false,"originAxisId":"tea"},{"id":"trust","kind":"attitude","label":"Trust","source":"reflection","range":{"min":0,"max":5},"initial":2,"locked":true,"originAxisId":"trust"}],"digest":"${GOLDEN_PERSONA_SCHEMA_DIGEST}"}`;

const definition = {
	version: 1 as const,
	worldId: "world",
	revision: 3,
	participants: ["lina"],
	traits: [
		{ id: "warmth", label: "Warmth", min: 0, max: 10, initial: 5 },
		{ id: "curiosity", label: "Curiosity", min: -1, max: 1, initial: 0 },
	],
	habits: [{ id: "tea", label: "Drinks tea", initial: true }],
	attitudes: [{ id: "trust", label: "Trust", min: 0, max: 5, initial: 2 }],
	projection: {
		revision: 1,
		sharedTraitIds: ["warmth", "curiosity"],
		sharedHabitIds: ["tea"],
		sharedAttitudeIds: ["trust"],
		disclosures: [],
	},
};

const lockProfile = {
	agentId: "lina",
	profileRevision: 4,
	evolution: "adaptive" as const,
	lockedTraitIds: ["warmth"],
	lockedHabitIds: [] as string[],
	lockedAttitudeIds: [] as string[],
};

const identityV1 = { version: 1 as const, profiles: [lockProfile] };
const identityV2 = {
	version: 2 as const,
	profiles: [
		{
			...lockProfile,
			personalBehavior: null,
			sourceStamp: null,
		},
	],
};

function derive(
	identity: typeof identityV1 | typeof identityV2 | null = identityV2,
): PersonaSchema {
	return personaSchemaFromLifeDefinition({
		agentId: "lina",
		revision: 1,
		definition,
		identity,
	});
}

function withDigest(schema: PersonaSchema): PersonaSchema {
	const body = {
		schemaVersion: schema.schemaVersion,
		agentId: schema.agentId,
		revision: schema.revision,
		sourceDefinition: schema.sourceDefinition,
		sourceIdentity: schema.sourceIdentity,
		dimensions: schema.dimensions,
	};
	return { ...body, digest: personaSchemaDigest(body) };
}

test("derivation maps two traits, one habit and one attitude in kind then id order with locked reflection sources", () => {
	const schema = derive();
	expect(schema.schemaVersion).toBe(1);
	expect(schema.agentId).toBe("lina");
	expect(schema.revision).toBe(1);
	expect(schema.dimensions).toHaveLength(4);
	expect(schema.dimensions.map((row) => row.kind)).toEqual([
		"trait",
		"trait",
		"habit",
		"attitude",
	]);
	expect(schema.dimensions.map((row) => row.id)).toEqual([
		"curiosity",
		"warmth",
		"tea",
		"trust",
	]);
	expect(schema.dimensions.map((row) => row.range)).toEqual([
		{ min: -1, max: 1 },
		{ min: 0, max: 10 },
		null,
		{ min: 0, max: 5 },
	]);
	expect(schema.dimensions.map((row) => row.initial)).toEqual([0, 5, true, 2]);
	expect(schema.dimensions.map((row) => row.locked)).toEqual([
		false,
		true,
		false,
		false,
	]);
	expect(schema.dimensions.every((row) => row.source === "reflection")).toBe(
		true,
	);
	expect(schema.dimensions.every((row) => row.originAxisId === row.id)).toBe(
		true,
	);
	expect(schema.dimensions.map((row) => row.label)).toEqual([
		"Curiosity",
		"Warmth",
		"Drinks tea",
		"Trust",
	]);
	const source = schema.sourceDefinition;
	expect(source).not.toBeNull();
	if (source === null) throw Error("expected sourceDefinition");
	expect(source.worldId).toBe("world");
	expect(source.definitionRevision).toBe(3);
	expect(source.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(schema.sourceIdentity).toEqual({ profileRevision: 4 });
});

test("derivation digest is idempotent and ignores v2-only identity fields", () => {
	const first = derive();
	const second = derive();
	expect(first.digest).toBe(second.digest);
	expect(first.digest).toBe(
		personaSchemaDigest({
			schemaVersion: first.schemaVersion,
			agentId: first.agentId,
			revision: first.revision,
			sourceDefinition: first.sourceDefinition,
			sourceIdentity: first.sourceIdentity,
			dimensions: first.dimensions,
		}),
	);

	const unlocked = derive(null);
	expect(unlocked.sourceIdentity).toBeNull();
	expect(unlocked.dimensions.every((row) => row.locked === false)).toBe(true);
	expect(unlocked.digest).not.toBe(first.digest);

	const fromV1 = derive(identityV1);
	const fromV2 = derive(identityV2);
	expect(fromV1.digest).toBe(fromV2.digest);
	expect(fromV1.digest).toBe(first.digest);

	const missing = personaSchemaFromLifeDefinition({
		agentId: "lina",
		revision: 1,
		definition,
		identity: {
			version: 2 as const,
			profiles: [
				{
					...lockProfile,
					agentId: "mira",
					personalBehavior: null,
					sourceStamp: null,
				},
			],
		},
	});
	expect(missing.sourceIdentity).toBeNull();
	expect(missing.dimensions.every((row) => row.locked === false)).toBe(true);
	expect(missing.digest).toBe(unlocked.digest);
});

test("parsePersonaSchema round-trips a derived schema", () => {
	const schema = derive();
	const parsed = parsePersonaSchema(schema);
	expect(parsed).toEqual(schema);
	expect(JSON.stringify(parsed)).toBe(JSON.stringify(schema));
});

test("labels at the LIFE text ceiling round-trip verbatim; one past it is rejected on both sides", () => {
	const atCeiling = "x".repeat(32_768);
	const pastCeiling = "x".repeat(32_769);
	const withLabel = (label: string) => ({
		...definition,
		traits: [{ id: "t", label, min: 0, max: 1, initial: 0 }],
		habits: [{ id: "h", label, initial: false }],
		attitudes: [{ id: "a", label, min: 0, max: 1, initial: 1 }],
		projection: {
			revision: 1,
			sharedTraitIds: ["t"],
			sharedHabitIds: ["h"],
			sharedAttitudeIds: ["a"],
			disclosures: [],
		},
	});
	const schema = personaSchemaFromLifeDefinition({
		agentId: "lina",
		revision: 1,
		definition: withLabel(atCeiling),
		identity: null,
	});
	expect(schema.dimensions.map((row) => row.label)).toEqual([
		atCeiling,
		atCeiling,
		atCeiling,
	]);
	expect(parsePersonaSchema(schema)).toEqual(schema);
	expect(() =>
		personaSchemaFromLifeDefinition({
			agentId: "lina",
			revision: 1,
			definition: withLabel(pastCeiling),
			identity: null,
		}),
	).toThrow();
	const tampered = withDigest({
		...schema,
		dimensions: schema.dimensions.map((row) =>
			row.kind === "trait" ? { ...row, label: pastCeiling } : row,
		),
	});
	expect(() => parsePersonaSchema(tampered)).toThrow(
		"invalid persona dimension label",
	);
	expect(() =>
		parsePersonaSchema(
			withDigest({
				...schema,
				dimensions: schema.dimensions.map((row) =>
					row.kind === "habit" ? { ...row, label: "   " } : row,
				),
			}),
		),
	).toThrow("invalid persona dimension label");
});

test("golden parses byte-identically", () => {
	expect(
		JSON.stringify(parsePersonaSchema(JSON.parse(GOLDEN_PERSONA_SCHEMA_JSON))),
	).toBe(GOLDEN_PERSONA_SCHEMA_JSON);
});

test("parsePersonaSchema rejects duplicate ids, unknown source, future version, tampered digest, and kind/range/initial mismatches", () => {
	const schema = derive();
	const duplicate = structuredClone(schema);
	const first = duplicate.dimensions[0];
	if (!first) throw Error("expected dimension");
	duplicate.dimensions.push({ ...first });
	expect(() => parsePersonaSchema(withDigest(duplicate))).toThrow(
		"duplicate persona dimension id",
	);

	const other = structuredClone(schema);
	const otherDimension = other.dimensions[0];
	if (!otherDimension) throw Error("expected dimension");
	(otherDimension as { source: string }).source = "other";
	expect(() => parsePersonaSchema(withDigest(other))).toThrow(
		"invalid persona dimension source",
	);

	expect(() => parsePersonaSchema({ ...schema, schemaVersion: 2 })).toThrow(
		/Unsupported persona schema version/,
	);

	const tampered = structuredClone(schema);
	tampered.digest = "b".repeat(64);
	expect(() => parsePersonaSchema(tampered)).toThrow();

	const traitRange = structuredClone(schema);
	const trait = traitRange.dimensions.find((row) => row.kind === "trait");
	if (!trait) throw Error("expected trait");
	trait.range = null;
	expect(() => parsePersonaSchema(withDigest(traitRange))).toThrow(
		"invalid persona dimension range",
	);

	const habitInitial = structuredClone(schema);
	const habit = habitInitial.dimensions.find((row) => row.kind === "habit");
	if (!habit) throw Error("expected habit");
	habit.initial = 1;
	expect(() => parsePersonaSchema(withDigest(habitInitial))).toThrow(
		"invalid persona dimension initial",
	);
});

test("parsePersonaSchema rejects unsorted dimensions on a correctly digested body", () => {
	const z: PersonaDimension = {
		id: "z",
		kind: "trait",
		label: "Z",
		source: "reflection",
		range: { min: 0, max: 1 },
		initial: 0,
		locked: false,
		originAxisId: "z",
	};
	const a: PersonaDimension = {
		id: "a",
		kind: "trait",
		label: "A",
		source: "reflection",
		range: { min: 0, max: 1 },
		initial: 0,
		locked: false,
		originAxisId: "a",
	};
	const body = {
		schemaVersion: 1 as const,
		agentId: "lina",
		revision: 1,
		sourceDefinition: {
			worldId: "world",
			definitionRevision: 1,
			definitionDigest: HASH,
		},
		sourceIdentity: { profileRevision: 1 },
		dimensions: [z, a],
	};
	expect(() =>
		parsePersonaSchema({ ...body, digest: personaSchemaDigest(body) }),
	).toThrow("unsorted persona dimensions");
});

test("personaSchemaFromLifeDefinition rejects cross-kind duplicate dimension ids", () => {
	expect(() =>
		personaSchemaFromLifeDefinition({
			agentId: "lina",
			revision: 1,
			definition: {
				version: 1,
				worldId: "world",
				revision: 1,
				participants: ["lina"],
				traits: [{ id: "same", label: "Trait", min: 0, max: 1, initial: 0 }],
				habits: [{ id: "same", label: "Habit", initial: true }],
				attitudes: [],
				projection: {
					revision: 1,
					sharedTraitIds: [],
					sharedHabitIds: [],
					sharedAttitudeIds: [],
					disclosures: [],
				},
			},
			identity: null,
		}),
	).toThrow("duplicate persona dimension id");
});

test("pinned BehaviorJobInput fingerprint is unchanged", () => {
	expect(
		behaviorFingerprint({
			version: 1,
			agentId: "lina",
			worldId: "world",
			profileRevision: 1,
			definitionRevision: 1,
			projectionRevision: 1,
			policyRevision: 0,
			modelSettingsRevision: 0,
			definitionDigest: HASH,
			projectionDigest: HASH,
			promptDigest: HASH,
			maxAttempts: 2,
			records: [
				{
					recordId: "rec-1",
					revision: 3,
					contentHash: HASH,
					proofDigest:
						"d425a65ef71512bbc143700c9be99888d38a5f0c2176ae20753b8312792cde70",
					proofs: [
						{
							entryId: "source",
							policyRevision: 1,
							policyDigest: HASH,
						},
					],
				},
			],
			selectors: {
				traits: [{ axisId: "warmth", min: 0, max: 10 }],
				habits: [{ habitId: "tea" }],
			},
		}),
	).toBe(PINNED_BEHAVIOR_FINGERPRINT);
});

test("agents index re-exports persona schema types and dimension sources", () => {
	expect(DIMENSION_SOURCES).toEqual(["reflection", "neural"]);
	const kind: PersonaDimensionKind = "trait";
	const source: DimensionSource = "reflection";
	const dimension: PersonaDimension = {
		id: "warmth",
		kind,
		label: "Warmth",
		source,
		range: { min: 0, max: 10 },
		initial: 5,
		locked: false,
		originAxisId: "warmth",
	};
	const ref: PersonaDimensionRef = {
		schemaRevision: 1,
		dimensionId: dimension.id,
		source,
	};
	const neural: NeuralProjectionRef = {
		schemaVersion: 1,
		agentId: "lina",
		scopeId: "personal",
		schemaRevision: 1,
		observationRef: "obs-1",
		projectionDigest: HASH,
	};
	expect(ref.source).toBe("reflection");
	expect(neural.schemaVersion).toBe(1);
	expect(dimension.kind).toBe("trait");
});
