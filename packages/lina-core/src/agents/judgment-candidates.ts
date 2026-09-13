import { INTENTION_STATUSES, type IntentionStatus } from "./judgment.ts";
import {
	type CanonicalOption,
	parseCanonicalOption,
} from "./judgment-catalog.ts";
import type { HostEligibility } from "./judgment-policy.ts";
import { judgmentDigest } from "./judgment-validation.ts";
import { boundedId, boundedText } from "./validation.ts";

/** Closed Host inputs, independent of assessment arrival order and session lifetime. */
export type CandidateSet = {
	schemaVersion: 1;
	roundId: string;
	snapshotDigest: string;
	options: CanonicalOption[];
	eligibility: HostEligibility;
	intentionRefs: Array<{
		intentionId: string;
		revision: number;
		status: IntentionStatus;
		digest: string;
	}>;
	candidateDigest: string;
};

function fields(
	value: unknown,
	keys: string[],
	label: string,
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw Error(`invalid ${label}`);
	const row = value as Record<string, unknown>;
	for (const key of Object.keys(row))
		if (!keys.includes(key)) throw Error(`unknown ${label} field ${key}`);
	for (const key of keys)
		if (!Object.hasOwn(row, key)) throw Error(`missing ${label} field ${key}`);
	return row;
}
function list<T>(value: unknown, parse: (value: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > 256)
		throw Error("invalid candidate list");
	return Array.from(value, parse);
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
	if (new Set(items.map(key)).size !== items.length)
		throw Error("duplicate candidate key");
	return items;
}
function sorted<T>(items: T[], key: (item: T) => string): T[] {
	return unique(items, key).sort((a, b) =>
		key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
	);
}

function candidateBody(value: unknown): Omit<CandidateSet, "candidateDigest"> {
	const {
		schemaVersion,
		roundId,
		snapshotDigest,
		options: rawOptions,
		eligibility: rawEligibility,
		intentionRefs: rawRefs,
	} = fields(
		value,
		[
			"schemaVersion",
			"roundId",
			"snapshotDigest",
			"options",
			"eligibility",
			"intentionRefs",
		],
		"candidate set",
	);
	if (schemaVersion !== 1)
		throw Error("Unsupported candidate set schema version");
	const options = sorted(
		list(rawOptions, parseCanonicalOption),
		(o) => o.optionKey,
	);
	const actor = options[0]?.actor;
	if (
		options.some(
			(o) =>
				o.actor.agentId !== actor?.agentId ||
				o.actor.scopeId !== actor?.scopeId,
		)
	)
		throw Error("candidate actor mismatch");
	const keys = new Set(options.map((o) => o.optionKey));
	// Eligibility is an ordered Host list, not a derived/defaulted set. Missing
	// rows remain missing and the policy treats them as ineligible.
	const eligibility = unique(
		list(rawEligibility, (value) => {
			const {
				optionKey: rawKey,
				eligible,
				reason,
			} = fields(
				value,
				["optionKey", "eligible", "reason"],
				"candidate eligibility",
			);
			const optionKey = boundedId(rawKey, "option key");
			if (!keys.has(optionKey)) throw Error("unknown eligibility option key");
			if (typeof eligible !== "boolean")
				throw Error("invalid candidate eligibility");
			return {
				optionKey,
				eligible,
				reason:
					reason === null ? null : boundedText(reason, "eligibility reason"),
			};
		}),
		(r) => r.optionKey,
	);
	const intentionRefs = sorted(
		list(rawRefs, (value) => {
			const {
				intentionId,
				revision,
				status: rawStatus,
				digest,
			} = fields(
				value,
				["intentionId", "revision", "status", "digest"],
				"candidate intention ref",
			);
			const status = INTENTION_STATUSES.find((s) => s === rawStatus);
			if (
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 0 ||
				status === undefined
			)
				throw Error("invalid candidate intention ref");
			return {
				intentionId: boundedId(intentionId, "intention id"),
				revision,
				status,
				digest: boundedId(digest, "intention digest"),
			};
		}),
		(r) => r.intentionId,
	);
	return {
		schemaVersion: 1,
		roundId: boundedId(roundId, "round id"),
		snapshotDigest: boundedId(snapshotDigest, "snapshot digest"),
		options,
		eligibility,
		intentionRefs,
	};
}

export function parseCandidateSet(value: unknown): CandidateSet {
	const row = fields(
		value,
		[
			"schemaVersion",
			"roundId",
			"snapshotDigest",
			"options",
			"eligibility",
			"intentionRefs",
			"candidateDigest",
		],
		"candidate set",
	);
	const { candidateDigest, ...rest } = row;
	const result = candidateBody(rest);
	if (candidateDigest !== judgmentDigest(result))
		throw Error("candidate set digest mismatch");
	return { ...result, candidateDigest };
}

export function buildCandidateSet(input: {
	roundId: string;
	snapshotDigest: string;
	options: CanonicalOption[];
	eligibility: HostEligibility;
	intentionRefs: CandidateSet["intentionRefs"];
}): CandidateSet {
	const result = candidateBody({ schemaVersion: 1, ...input });
	return { ...result, candidateDigest: judgmentDigest(result) };
}
