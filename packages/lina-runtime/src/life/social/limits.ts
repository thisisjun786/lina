export const SOCIAL_PROCESS_LIMITS = {
	memoryBytes: 512 * 1024 * 1024,
	cpuSeconds: 3,
	timeoutMs: 5_000,
	maxBytes: 4 * 1024 * 1024,
	stderrBytes: 16 * 1024,
	concurrent: 4,
} as const;
