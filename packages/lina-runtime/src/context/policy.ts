import { createHash } from "node:crypto";

export interface ContextBudgetPolicy {
	version: 1;
	leafInputTokens: number;
	leafOutputTokens: number;
	condensedOutputTokens: number;
	freshTailEntries: number;
	expansionTokens: number;
	injectionTokens: number;
	refreshThresholdTokens: number;
	maxSearchCalls: number;
}
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextBudgetPolicy> =
	Object.freeze({
		version: 1,
		leafInputTokens: 7000,
		leafOutputTokens: 2048,
		condensedOutputTokens: 512,
		freshTailEntries: 4,
		expansionTokens: 1024,
		injectionTokens: 2048,
		refreshThresholdTokens: 3000,
		maxSearchCalls: 8,
	});
const ranges: Record<
	Exclude<keyof ContextBudgetPolicy, "version">,
	readonly [number, number]
> = {
	leafInputTokens: [128, 32768],
	leafOutputTokens: [1, 8192],
	condensedOutputTokens: [1, 8192],
	freshTailEntries: [0, 100],
	expansionTokens: [128, 8192],
	injectionTokens: [128, 8192],
	refreshThresholdTokens: [1, 1048576],
	maxSearchCalls: [1, 100],
};
export function parseContextBudgetPolicy(raw: unknown): ContextBudgetPolicy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw Error("Invalid context budget policy");
	const value = raw as Record<string, unknown>;
	if (
		value["version"] !== 1 ||
		Reflect.ownKeys(value).length !==
			Object.keys(DEFAULT_CONTEXT_POLICY).length ||
		Object.keys(value).some((k) => !Object.hasOwn(DEFAULT_CONTEXT_POLICY, k))
	)
		throw Error("Unknown context budget policy fields or version");
	for (const [key, [min, max]] of Object.entries(ranges)) {
		const v = value[key];
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
			throw Error(`Invalid context budget ${key}`);
	}
	return {
		version: 1,
		...Object.fromEntries(Object.keys(ranges).map((k) => [k, value[k]])),
	} as ContextBudgetPolicy;
}
export function contextPolicyDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
