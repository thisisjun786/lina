import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSourceProof } from "../source-policy.ts";
import type {
	BehaviorFailReason,
	BehaviorJobInput,
	BehaviorJobState,
	BehaviorRecordRef,
	BehaviorSourceStamp,
	FrozenHabitSelector,
	FrozenTraitSelector,
	PersonalBehavior,
	PersonalBehaviorOutput,
	PersonalHabitOutput,
	PersonalTraitOutput,
} from "./behavior-types.ts";
import {
	BEHAVIOR_FAIL_REASONS,
	BEHAVIOR_JOB_STATES,
} from "./behavior-types.ts";
import { boundedId } from "./validation.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 32;
const MAX_SELECTORS = 32;
const MAX_EVIDENCE = 32;

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
	keys: string[],
	label: string,
): void {
	const names = Object.getOwnPropertyNames(value);
	if (
		keys.some((key) => !Object.hasOwn(value, key)) ||
		names.some((key) => !keys.includes(key))
	)
		throw Error("invalid or unknown " + label + " fields");
}

function revision(value: unknown, label: string, min = 0): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > Number.MAX_SAFE_INTEGER - 1
	)
		throw Error("invalid " + label);
	return value;
}

function digest(value: unknown, label: string): string {
	if (typeof value !== "string" || !HASH.test(value))
		throw Error("invalid " + label);
	return value;
}

export function behaviorDigest(value: unknown): string {
	const canonical = (item: unknown): unknown =>
		Array.isArray(item)
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
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

function uniqueIds(ids: string[], label: string): string[] {
	if (new Set(ids).size !== ids.length) throw Error("duplicate " + label);
	return ids;
}

function parseRecord(value: unknown): BehaviorRecordRef {
	const row = object(value, "behavior record");
	exact(
		row,
		["recordId", "revision", "contentHash", "proofDigest", "proofs"],
		"behavior record",
	);
	if (
		!Array.isArray(row["proofs"]) ||
		row["proofs"].length === 0 ||
		row["proofs"].length > 65536
	)
		throw Error("invalid behavior proofs");
	const proofs = row["proofs"].map(parseSourceProof);
	uniqueIds(
		proofs.map((p) => p.entryId),
		"behavior proof",
	);
	if (behaviorDigest(proofs) !== row["proofDigest"])
		throw Error("behavior proof digest mismatch");
	return {
		proofs,
		recordId: boundedId(row["recordId"], "record id"),
		revision: revision(row["revision"], "record revision"),
		contentHash: digest(row["contentHash"], "content hash"),
		proofDigest: digest(row["proofDigest"], "proof digest"),
	};
}

function parseTraitSelector(value: unknown): FrozenTraitSelector {
	const row = object(value, "trait selector");
	exact(row, ["axisId", "min", "max"], "trait selector");
	const min = row["min"];
	const max = row["max"];
	if (
		typeof min !== "number" ||
		typeof max !== "number" ||
		!Number.isFinite(min) ||
		!Number.isFinite(max) ||
		min > max
	)
		throw Error("invalid trait selector bounds");
	return { axisId: boundedId(row["axisId"], "axis id"), min, max };
}

function parseHabitSelector(value: unknown): FrozenHabitSelector {
	const row = object(value, "habit selector");
	exact(row, ["habitId"], "habit selector");
	return { habitId: boundedId(row["habitId"], "habit id") };
}

export function parseBehaviorJobInput(value: unknown): BehaviorJobInput {
	const row = object(value, "behavior job");
	exact(
		row,
		[
			"version",
			"agentId",
			"worldId",
			"profileRevision",
			"definitionRevision",
			"projectionRevision",
			"policyRevision",
			"modelSettingsRevision",
			"definitionDigest",
			"projectionDigest",
			"promptDigest",
			"maxAttempts",
			"records",
			"selectors",
		],
		"behavior job",
	);
	if (row["version"] !== 1) throw Error("unknown behavior job version");
	if (!Array.isArray(row["records"]) || row["records"].length > MAX_RECORDS)
		throw Error("invalid behavior records");
	const records = row["records"].map(parseRecord);
	uniqueIds(
		records.map((record) => record.recordId),
		"record id",
	);
	const selectors = object(row["selectors"], "behavior selectors");
	exact(selectors, ["traits", "habits"], "behavior selectors");
	if (
		!Array.isArray(selectors["traits"]) ||
		selectors["traits"].length > MAX_SELECTORS ||
		!Array.isArray(selectors["habits"]) ||
		selectors["habits"].length > MAX_SELECTORS
	)
		throw Error("invalid behavior selectors");
	const traits = selectors["traits"].map(parseTraitSelector);
	const habits = selectors["habits"].map(parseHabitSelector);
	uniqueIds(
		traits.map((item) => item.axisId),
		"axis id",
	);
	uniqueIds(
		habits.map((item) => item.habitId),
		"habit id",
	);
	const maxAttempts = revision(row["maxAttempts"], "maxAttempts", 1);
	if (maxAttempts > 3) throw Error("invalid maxAttempts");
	return {
		version: 1,
		agentId: boundedId(row["agentId"], "agent id"),
		worldId: boundedId(row["worldId"], "world id"),
		profileRevision: revision(row["profileRevision"], "profile revision", 1),
		definitionRevision: revision(
			row["definitionRevision"],
			"definition revision",
			1,
		),
		projectionRevision: revision(
			row["projectionRevision"],
			"projection revision",
			1,
		),
		policyRevision: revision(row["policyRevision"], "policy revision"),
		modelSettingsRevision: revision(
			row["modelSettingsRevision"],
			"model settings revision",
		),
		definitionDigest: digest(row["definitionDigest"], "definition digest"),
		projectionDigest: digest(row["projectionDigest"], "projection digest"),
		promptDigest: digest(row["promptDigest"], "prompt digest"),
		maxAttempts,
		records,
		selectors: { traits, habits },
	};
}

export function behaviorFingerprint(input: BehaviorJobInput): string {
	return behaviorDigest({
		version: input.version,
		agentId: input.agentId,
		worldId: input.worldId,
		profileRevision: input.profileRevision,
		definitionRevision: input.definitionRevision,
		projectionRevision: input.projectionRevision,
		policyRevision: input.policyRevision,
		modelSettingsRevision: input.modelSettingsRevision,
		definitionDigest: input.definitionDigest,
		projectionDigest: input.projectionDigest,
		maxAttempts: input.maxAttempts,
		records: input.records.map((record) => ({
			recordId: record.recordId,
			contentHash: record.contentHash,
		})),
		selectors: input.selectors,
	});
}

function evidenceIds(value: unknown, allowed: Set<string>): string[] {
	if (!Array.isArray(value) || value.length > MAX_EVIDENCE)
		throw Error("invalid evidence ids");
	const ids = value.map((id) => boundedId(id, "evidence id"));
	uniqueIds(ids, "evidence id");
	if (ids.some((id) => !allowed.has(id)))
		throw Error("evidence is not a subset of input records");
	return ids;
}

export function parsePersonalBehaviorOutput(
	value: unknown,
	input: BehaviorJobInput,
): PersonalBehaviorOutput {
	const row = object(value, "behavior output");
	exact(row, ["traits", "habits"], "behavior output");
	if ("attitudes" in row || "text" in row)
		throw Error("invalid behavior output fields");
	if (!Array.isArray(row["traits"]) || !Array.isArray(row["habits"]))
		throw Error("invalid behavior output");
	const allowed = new Set(input.records.map((record) => record.recordId));
	const axes = new Map(
		input.selectors.traits.map((item) => [item.axisId, item]),
	);
	const habits = new Set(input.selectors.habits.map((item) => item.habitId));
	const traits = row["traits"].map((item): PersonalTraitOutput => {
		const trait = object(item, "trait output");
		exact(trait, ["axisId", "value", "evidenceIds"], "trait output");
		if ("kind" in trait) throw Error("invalid trait output fields");
		const axisId = boundedId(trait["axisId"], "axis id");
		const selector = axes.get(axisId);
		if (!selector) throw Error("unknown trait axis");
		const number = trait["value"];
		if (typeof number !== "number" || !Number.isFinite(number))
			throw Error("invalid trait value");
		if (number < selector.min || number > selector.max)
			throw Error("trait value out of bounds");
		return {
			axisId,
			value: number === 0 ? 0 : number,
			evidenceIds: evidenceIds(trait["evidenceIds"], allowed),
		};
	});
	const habitRows = row["habits"].map((item): PersonalHabitOutput => {
		const habit = object(item, "habit output");
		exact(habit, ["habitId", "value", "evidenceIds"], "habit output");
		if ("kind" in habit) throw Error("invalid habit output fields");
		const habitId = boundedId(habit["habitId"], "habit id");
		if (!habits.has(habitId)) throw Error("unknown habit id");
		if (typeof habit["value"] !== "boolean") throw Error("invalid habit value");
		return {
			habitId,
			value: habit["value"],
			evidenceIds: evidenceIds(habit["evidenceIds"], allowed),
		};
	});
	uniqueIds(
		traits.map((item) => item.axisId),
		"axis id",
	);
	uniqueIds(
		habitRows.map((item) => item.habitId),
		"habit id",
	);
	return { traits, habits: habitRows };
}

export function projectPersonalBehavior(
	output: PersonalBehaviorOutput,
): PersonalBehavior {
	return {
		traits: output.traits.map((item) => ({
			axisId: item.axisId,
			value: item.value,
		})),
		habits: output.habits.map((item) => ({
			habitId: item.habitId,
			value: item.value,
		})),
	};
}

export function parseBehaviorSourceStamp(value: unknown): BehaviorSourceStamp {
	const row = object(value, "behavior source stamp");
	exact(
		row,
		[
			"digest",
			"receiptRevision",
			"profileRevision",
			"definitionRevision",
			"projectionRevision",
		],
		"behavior source stamp",
	);
	return {
		digest: digest(row["digest"], "source digest"),
		receiptRevision: revision(row["receiptRevision"], "receipt revision", 1),
		profileRevision: revision(row["profileRevision"], "profile revision", 1),
		definitionRevision: revision(
			row["definitionRevision"],
			"definition revision",
			1,
		),
		projectionRevision: revision(
			row["projectionRevision"],
			"projection revision",
			1,
		),
	};
}

export function parseBehaviorJobState(value: unknown): BehaviorJobState {
	if (
		typeof value !== "string" ||
		!BEHAVIOR_JOB_STATES.includes(value as BehaviorJobState)
	)
		throw Error("invalid behavior job state");
	return value as BehaviorJobState;
}

export function parseBehaviorFailReason(value: unknown): BehaviorFailReason {
	if (
		typeof value !== "string" ||
		!BEHAVIOR_FAIL_REASONS.includes(value as BehaviorFailReason)
	)
		throw Error("invalid behavior fail reason");
	return value as BehaviorFailReason;
}

export function sameBehaviorInput(
	left: BehaviorJobInput,
	right: BehaviorJobInput,
): boolean {
	return isDeepStrictEqual(left, right);
}

export function behaviorReceiptStamp(
	id: string,
	revisionValue: number,
	input: BehaviorJobInput,
	output: PersonalBehaviorOutput,
): BehaviorSourceStamp {
	return parseBehaviorSourceStamp({
		digest: behaviorDigest({
			receiptId: id,
			records: input.records.map((record) => ({
				recordId: record.recordId,
				contentHash: record.contentHash,
				proofDigest: record.proofDigest,
			})),
			output,
		}),
		receiptRevision: revisionValue,
		profileRevision: input.profileRevision,
		definitionRevision: input.definitionRevision,
		projectionRevision: input.projectionRevision,
	});
}
