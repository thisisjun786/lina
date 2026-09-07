import { fileURLToPath } from "node:url";
import { validateSocialCheckpoint } from "../../../../lina-core/src/world/social-checkpoint.ts";
import {
	parseSocialResolution,
	parseSocialResolveInput,
} from "../../../../lina-core/src/world/social-validation.ts";
import { SOCIAL_PROCESS_LIMITS } from "./limits.ts";
import type { SocialEnginePort } from "./port.ts";
import { reducedLimit, runSocialProcess } from "./process.ts";

export function createEnsembleSocialEngine(
	options: { timeoutMs?: number; memoryBytes?: number } = {},
): SocialEnginePort {
	const timeoutMs = reducedLimit(
		options.timeoutMs,
		SOCIAL_PROCESS_LIMITS.timeoutMs,
	);
	const memoryBytes = reducedLimit(
		options.memoryBytes,
		SOCIAL_PROCESS_LIMITS.memoryBytes,
	);
	return {
		async resolve(value, signal) {
			if (signal.aborted) throw Error("Social engine aborted");
			const input = parseSocialResolveInput(value);
			validateSocialCheckpoint(input.checkpoint, input.rulePack);
			const processResult = await runSocialProcess({
				entrypoint: fileURLToPath(new URL("./worker.ts", import.meta.url)),
				input: JSON.stringify(input),
				signal,
				timeoutMs,
				memoryBytes,
				maxBytes: input.limits.maxBytes,
			});
			const result = parseSocialResolution(JSON.parse(processResult.output));
			validateSocialCheckpoint(result.checkpoint, input.rulePack);
			if (result.requestId !== input.requestId)
				throw Error("Social engine result request mismatch");
			return result;
		},
	};
}
