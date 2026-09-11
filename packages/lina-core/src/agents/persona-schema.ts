import { createHash } from "node:crypto";
import { lifeDigest } from "../world/life-json.ts";
import type {
	IdentityPolicySnapshot,
	LifeDefinition,
} from "../world/life-types.ts";
import { parseLifeDefinition } from "../world/life-validation.ts";
import { DIMENSION_SOURCES, type DimensionSource } from "./behavior-types.ts";
import { boundedId } from "./validation.ts";

const SCHEMA_KEYS = [
	"schemaVersion",
	"agentId",
	"revision",
	"sourceDefinition",
	"sourceIdentity",
	"dimensions",
	"digest",
] as const;
const DIMENSION_KEYS = [
	"id",
	"kind",
	"label",
	"source",
	"range",
	"initial",
	"locked",
	"originAxisId",
] as const;
const KIND_RANK = { trait: 0, habit: 1, attitude: 2 } as const;
const HASH = /^[a-f0-9]{64}$/;
// Labels are copied verbatim from LIFE axes, so the persona bound must equal
// the LIFE text ceiling (world/validation.ts MAX_TEXT), not the agent-text one.
const MAX_LABEL = 32_768;

export type PersonaDimensionKind = "trait" | "habit" | "attitude";

export type PersonaDimension = {
	id: string;
	kind: PersonaDimensionKind;
	label: string;
	source: DimensionSource;
	range: { min: number; max: number } | null;
	initial: number | boolean;
	locked: boolean;
	originAxisId: string | null;
};

export type PersonaSchema = {
	schemaVersion: 1;
	agentId: string;
	revision: number;
	sourceDefinition: {
		worldId: string;
		definitionRevision: number;
		definitionDigest: string;
	} | null;
	sourceIdentity: { profileRevision: number } | null;
	dimensions: PersonaDimension[];
	digest: string;
};

function object(value: unknown, label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw Error("invalid " + label);
	return value as Record<string, unknown>;
}

function exact(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw Error(`unknown ${label} field ${key}`);
	for (const key of keys)
		if (!Object.hasOwn(value, key)) throw Error("invalid " + label);
}

function revision(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw Error("invalid " + label);
	return value;
}

function digestValue(value: unknown, label: string): string {
	if (typeof value !== "string" || !HASH.test(value))
		throw Error("invalid " + label);
	return value;
}

function canonical(item: unknown): unknown {
	return Array.isArray(item)
		? item.map(canonical)
		: item !== null && typeof item === "object"
			? Object.fromEntries(
					Object.keys(item)
						.sort()
						.map((key) => [
							key,
							canonical((item as Record<string, unknown>)[key]),
						]),
				)
			: item;
}

export function personaSchemaDigest(
	schema: Omit<PersonaSchema, "digest">,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(schema)))
		.digest("hex");
}

function parseLabel(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > MAX_LABEL
	)
		throw Error("invalid persona dimension label");
	return value;
}

function parseKind(value: unknown): PersonaDimensionKind {
	if (value === "trait" || value === "habit" || value === "attitude")
		return value;
	throw Error("invalid persona dimension kind");
}

function parseSource(value: unknown): DimensionSource {
	for (const allowed of DIMENSION_SOURCES)
		if (allowed === value) return allowed;
	throw Error("invalid persona dimension source");
}

function parseRange(value: unknown): { min: number; max: number } {
	const row = object(value, "persona dimension range");
	exact(row, ["min", "max"], "persona dimension range");
	const min = row["min"];
	const max = row["max"];
	if (
		typeof min !== "number" ||
		typeof max !== "number" ||
		!Number.isFinite(min) ||
		!Number.isFinite(max) ||
		min > max
	)
		throw Error("invalid persona dimension range");
	return { min, max };
}

function parseDimension(value: unknown): PersonaDimension {
	const row = object(value, "persona dimension");
	exact(row, DIMENSION_KEYS, "persona dimension");
	const kind = parseKind(row["kind"]);
	const rangeValue = row["range"];
	const initial = row["initial"];
	if (kind === "habit") {
		if (rangeValue !== null) throw Error("invalid persona dimension range");
		if (typeof initial !== "boolean")
			throw Error("invalid persona dimension initial");
		if (typeof row["locked"] !== "boolean")
			throw Error("invalid persona dimension locked");
		return {
			id: boundedId(row["id"], "persona dimension id"),
			kind,
			label: parseLabel(row["label"]),
			source: parseSource(row["source"]),
			range: null,
			initial,
			locked: row["locked"],
			originAxisId:
				row["originAxisId"] === null
					? null
					: boundedId(row["originAxisId"], "origin axis id"),
		};
	}
	if (rangeValue === null) throw Error("invalid persona dimension range");
	const range = parseRange(rangeValue);
	if (
		typeof initial !== "number" ||
		!Number.isFinite(initial) ||
		initial < range.min ||
		initial > range.max
	)
		throw Error("invalid persona dimension initial");
	if (typeof row["locked"] !== "boolean")
		throw Error("invalid persona dimension locked");
	return {
		id: boundedId(row["id"], "persona dimension id"),
		kind,
		label: parseLabel(row["label"]),
		source: parseSource(row["source"]),
		range,
		initial: initial === 0 ? 0 : initial,
		locked: row["locked"],
		originAxisId:
			row["originAxisId"] === null
				? null
				: boundedId(row["originAxisId"], "origin axis id"),
	};
}

function parseSourceDefinition(
	value: unknown,
): PersonaSchema["sourceDefinition"] {
	if (value === null) return null;
	const row = object(value, "persona schema source definition");
	exact(
		row,
		["worldId", "definitionRevision", "definitionDigest"],
		"persona schema source definition",
	);
	return {
		worldId: boundedId(row["worldId"], "world id"),
		definitionRevision: revision(
			row["definitionRevision"],
			"definition revision",
		),
		definitionDigest: digestValue(row["definitionDigest"], "definition digest"),
	};
}

function parseSourceIdentity(value: unknown): PersonaSchema["sourceIdentity"] {
	if (value === null) return null;
	const row = object(value, "persona schema source identity");
	exact(row, ["profileRevision"], "persona schema source identity");
	return {
		profileRevision: revision(row["profileRevision"], "profile revision"),
	};
}

export function parsePersonaSchema(value: unknown): PersonaSchema {
	const row = object(value, "persona schema");
	if (row["schemaVersion"] !== 1)
		throw Error("Unsupported persona schema version");
	exact(row, SCHEMA_KEYS, "persona schema");
	if (!Array.isArray(row["dimensions"]))
		throw Error("invalid persona schema dimensions");
	const dimensions = row["dimensions"].map(parseDimension);
	const ids = new Set<string>();
	let previous: PersonaDimension | undefined;
	for (const dimension of dimensions) {
		if (ids.has(dimension.id)) throw Error("duplicate persona dimension id");
		ids.add(dimension.id);
		if (previous !== undefined && compareDimensions(previous, dimension) >= 0)
			throw Error("unsorted persona dimensions");
		previous = dimension;
	}
	const parsed: Omit<PersonaSchema, "digest"> = {
		schemaVersion: 1,
		agentId: boundedId(row["agentId"], "agent id"),
		revision: revision(row["revision"], "persona schema revision"),
		sourceDefinition: parseSourceDefinition(row["sourceDefinition"]),
		sourceIdentity: parseSourceIdentity(row["sourceIdentity"]),
		dimensions,
	};
	const digest = digestValue(row["digest"], "persona schema digest");
	if (digest !== personaSchemaDigest(parsed))
		throw Error("persona schema digest mismatch");
	return { ...parsed, digest };
}

function compareDimensions(a: PersonaDimension, b: PersonaDimension): number {
	const delta = KIND_RANK[a.kind] - KIND_RANK[b.kind];
	if (delta !== 0) return delta;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

function profileFor(
	identity: IdentityPolicySnapshot | null,
	agentId: string,
): {
	profileRevision: number;
	lockedTraitIds: string[];
	lockedHabitIds: string[];
	lockedAttitudeIds: string[];
} | null {
	if (identity === null) return null;
	for (const profile of identity.profiles)
		if (profile.agentId === agentId) return profile;
	return null;
}

function lockedFor(
	policy: {
		lockedTraitIds: string[];
		lockedHabitIds: string[];
		lockedAttitudeIds: string[];
	} | null,
	kind: PersonaDimensionKind,
	id: string,
): boolean {
	if (policy === null) return false;
	if (kind === "trait") return policy.lockedTraitIds.includes(id);
	if (kind === "habit") return policy.lockedHabitIds.includes(id);
	return policy.lockedAttitudeIds.includes(id);
}

export function personaSchemaFromLifeDefinition(input: {
	agentId: string;
	revision: number;
	definition: LifeDefinition;
	identity: IdentityPolicySnapshot | null;
}): PersonaSchema {
	const agentId = boundedId(input.agentId, "agent id");
	const schemaRevision = revision(input.revision, "persona schema revision");
	const definition = parseLifeDefinition(input.definition);
	const policy = profileFor(input.identity, agentId);
	const dimensions: PersonaDimension[] = [
		...definition.traits.map((axis) => ({
			id: axis.id,
			kind: "trait" as const,
			label: axis.label,
			source: "reflection" as const,
			range: { min: axis.min, max: axis.max },
			initial: axis.initial,
			locked: lockedFor(policy, "trait", axis.id),
			originAxisId: axis.id,
		})),
		...definition.habits.map((habit) => ({
			id: habit.id,
			kind: "habit" as const,
			label: habit.label,
			source: "reflection" as const,
			range: null,
			initial: habit.initial,
			locked: lockedFor(policy, "habit", habit.id),
			originAxisId: habit.id,
		})),
		...definition.attitudes.map((axis) => ({
			id: axis.id,
			kind: "attitude" as const,
			label: axis.label,
			source: "reflection" as const,
			range: { min: axis.min, max: axis.max },
			initial: axis.initial,
			locked: lockedFor(policy, "attitude", axis.id),
			originAxisId: axis.id,
		})),
	].sort(compareDimensions);
	const ids = new Set<string>();
	for (const dimension of dimensions) {
		if (ids.has(dimension.id)) throw Error("duplicate persona dimension id");
		ids.add(dimension.id);
	}
	const parsed: Omit<PersonaSchema, "digest"> = {
		schemaVersion: 1,
		agentId,
		revision: schemaRevision,
		sourceDefinition: {
			worldId: definition.worldId,
			definitionRevision: definition.revision,
			definitionDigest: lifeDigest(definition),
		},
		sourceIdentity:
			policy === null ? null : { profileRevision: policy.profileRevision },
		dimensions,
	};
	return { ...parsed, digest: personaSchemaDigest(parsed) };
}
