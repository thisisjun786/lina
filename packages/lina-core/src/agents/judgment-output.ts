import type { Assessment } from "./judgment.ts";
import {
	assessmentInputDigest,
	parseAssessment,
	prepareReadout,
} from "./judgment-validation.ts";

/** Prepare a new model judgment before its immutable record digest is created. */
export function buildAssessment(
	input: Omit<Assessment, "inputDigest">,
): Assessment {
	const readout = prepareReadout(input.completeText, "complete text");
	const parsed = parseAssessment({
		...input,
		inputDigest: assessmentInputDigest(input),
		completeText: readout.text,
	});
	if (Object.hasOwn(parsed.diagnostics, "readoutTruncation"))
		throw Error("fresh assessment must not supply truncation metadata");
	if (readout.truncation)
		parsed.diagnostics = {
			...parsed.diagnostics,
			readoutTruncation: readout.truncation,
		};
	return parsed;
}
