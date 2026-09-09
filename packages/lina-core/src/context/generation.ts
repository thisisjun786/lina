export interface SummaryGeneration {
	version: 1;
	policyDigest: string;
	routeKey: string;
	estimatorId: string;
	inputDigest: string;
}
export function parseSummaryGeneration(value: unknown): SummaryGeneration {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Invalid summary generation");
	const row = value as Record<string, unknown>,
		keys = [
			"version",
			"policyDigest",
			"routeKey",
			"estimatorId",
			"inputDigest",
		];
	if (
		Reflect.ownKeys(row).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(row, k)) ||
		row["version"] !== 1
	)
		throw Error("Unknown summary generation fields or version");
	for (const k of ["policyDigest", "inputDigest"])
		if (typeof row[k] !== "string" || !/^[a-f0-9]{64}$/.test(row[k]))
			throw Error("Invalid summary generation digest");
	for (const [k, max] of [
		["routeKey", 4096],
		["estimatorId", 128],
	] as const)
		if (
			typeof row[k] !== "string" ||
			!row[k].trim() ||
			row[k].length > max ||
			row[k].includes("\0")
		)
			throw Error("Invalid summary generation identity");
	return {
		version: 1,
		policyDigest: row["policyDigest"] as string,
		inputDigest: row["inputDigest"] as string,
		routeKey: row["routeKey"] as string,
		estimatorId: row["estimatorId"] as string,
	};
}
