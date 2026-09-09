import { isDeepStrictEqual } from "node:util";
import type { EpisodeTrace, PublicCase } from "./harness-types.ts";
import { runEpisode } from "./runner.ts";
import { decodeTrace } from "./trace.ts";

// Reconstruct protocol provenance only. Independent private truth still scores behavior.
// No provider or durable user state is touched; defaults outside replay keep random IDs.
export async function verifyReplay(
	input: PublicCase,
	value: EpisodeTrace,
): Promise<void> {
	const trace = decodeTrace(value, input);
	let calls = 0;
	let decisions = 0;
	const replayed = await runEpisode(
		input,
		trace.mode,
		{
			complete: async (messages) => {
				const request = trace.requests[calls++];
				if (!request || !isDeepStrictEqual(messages, request.input.messages))
					throw Error("recorded input differs from scenario replay");
				return structuredClone(request.transport);
			},
		},
		undefined,
		() => {
			const step = trace.steps[decisions++];
			if (!step) throw Error("replay has an undeclared decision");
			return step.kernel.decisionId;
		},
	);
	if (
		calls !== trace.requests.length ||
		decisions !== trace.steps.length ||
		!isDeepStrictEqual(replayed, trace)
	)
		throw Error("recorded trace differs from scenario replay");
}
