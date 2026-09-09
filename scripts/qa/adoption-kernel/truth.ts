export const BEHAVIOR_IDS = Array.from(
	{ length: 15 },
	(_, i) => `B${String(i + 1).padStart(2, "0")}`,
);
export const HOST_IDS = Array.from(
	{ length: 15 },
	(_, i) => `H${String(i + 1).padStart(2, "0")}`,
);
export type PrivateTruth = {
	version: 1;
	episodeId: string;
	row: string;
	seed: string;
	variant: number;
	subcase: "main" | "visible" | "omitted";
	expected: {
		value: string | null;
		missing: string[];
		sources: string[];
		required: string[];
		lookupKeys: string[];
		operands: number[];
		operation: string | null;
		role: "performer" | "observer" | "recipient" | null;
		domain: "real" | "fiction" | null;
		sourceEvidenceId: string | null;
		finalStage: number;
	};
};
export type TrialScore = {
	episodeId: string;
	row: string;
	mode: string;
	quality: boolean;
	uptake: boolean | null;
	incomplete: boolean;
	reasons: string[];
};
export function decodeTruth(value: unknown): PrivateTruth {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid private truth");
	const row = value as PrivateTruth;
	if (
		row.version !== 1 ||
		!BEHAVIOR_IDS.includes(row.row) ||
		typeof row.episodeId !== "string" ||
		typeof row.seed !== "string" ||
		!Number.isSafeInteger(row.variant) ||
		!row.expected
	)
		throw Error("invalid private truth identity");
	const e = row.expected;
	if (e.value !== null && typeof e.value !== "string")
		throw Error("invalid expected value");
	for (const items of [e.missing, e.sources, e.required, e.lookupKeys])
		if (!Array.isArray(items) || !items.every((x) => typeof x === "string"))
			throw Error("invalid expected list");
	if (
		!Array.isArray(e.operands) ||
		!e.operands.every(Number.isSafeInteger) ||
		!Number.isSafeInteger(e.finalStage)
	)
		throw Error("invalid expected numeric fields");
	if (!["main", "visible", "omitted"].includes(row.subcase))
		throw Error("invalid subcase");
	return structuredClone(row);
}
