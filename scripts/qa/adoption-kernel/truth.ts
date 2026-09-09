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
	seed: string;
	variant: number;
	subcase: string;
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
	const exact = (input: object, keys: string[]) =>
		Object.keys(input).length === keys.length &&
		Object.keys(input).every((key) => keys.includes(key));
	if (
		!exact(row, [
			"version",
			"episodeId",
			"row",
			"seed",
			"variant",
			"subcase",
			"expected",
		])
	)
		throw Error("unknown private fields");
	if (
		row.version !== 1 ||
		!BEHAVIOR_IDS.includes(row.row) ||
		typeof row.episodeId !== "string" ||
		typeof row.seed !== "string" ||
		!Number.isSafeInteger(row.variant) ||
		row.variant < 0 ||
		row.variant > 3 ||
		!row.episodeId ||
		!row.seed ||
		!row.expected
	)
		throw Error("invalid private truth identity");
	const e = row.expected;
	if (
		typeof e !== "object" ||
		Array.isArray(e) ||
		!exact(e, [
			"value",
			"missing",
			"sources",
			"required",
			"lookupKeys",
			"operands",
			"operation",
			"role",
			"domain",
			"sourceEvidenceId",
			"finalStage",
		])
	)
		throw Error("unknown expected fields");
	if (
		![null, "add", "subtract", "multiply"].includes(e.operation) ||
		![null, "performer", "observer", "recipient"].includes(e.role) ||
		![null, "real", "fiction"].includes(e.domain)
	)
		throw Error("invalid expected enum");
	if (
		e.sourceEvidenceId !== null &&
		(typeof e.sourceEvidenceId !== "string" || !e.sourceEvidenceId)
	)
		throw Error("invalid expected source");
	if (e.value !== null && typeof e.value !== "string")
		throw Error("invalid expected value");
	for (const items of [e.missing, e.sources, e.required, e.lookupKeys])
		if (!Array.isArray(items) || !items.every((x) => typeof x === "string"))
			throw Error("invalid expected list");
	if (
		!Array.isArray(e.operands) ||
		!e.operands.every(Number.isSafeInteger) ||
		!Number.isSafeInteger(e.finalStage) ||
		e.finalStage < 0 ||
		e.finalStage > 5
	)
		throw Error("invalid expected numeric fields");
	if (!["main", "visible", "omitted"].includes(row.subcase))
		throw Error("invalid subcase");
	if (row.row === "B15" ? row.subcase === "main" : row.subcase !== "main")
		throw Error("incompatible subcase");
	return structuredClone(row);
}
