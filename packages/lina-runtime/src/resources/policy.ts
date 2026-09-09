import { z } from "zod";

const resourcePolicySchema = z.strictObject({
	enabled: z.boolean(),
	maxVisits: z.number().int().min(1).max(200),
	maxCalls: z.number().int().min(1).max(8),
	inputTokens: z.number().int().min(128).max(32768),
	outputTokens: z.number().int().min(1).max(8192),
	maxAttempts: z.number().int().min(1).max(3),
});
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;
/** Technical ceilings; does not schedule work or authorize provider spending. */
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = Object.freeze({
	enabled: true,
	maxVisits: 32,
	maxCalls: 3,
	inputTokens: 7000,
	outputTokens: 1024,
	maxAttempts: 3,
});
export function parseResourcePolicy(input: unknown): ResourcePolicy {
	return resourcePolicySchema.parse(input);
}
