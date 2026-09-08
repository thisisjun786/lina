import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SourceProof } from "../source-policy-types.ts";
import { parseLearnedProofs } from "./learned-provenance.ts";
import type { ReflectionInput } from "./types.ts";
import { validateReflection } from "./validation.ts";

/** A deterministic receipt commitment, not a secret or a database authentication claim. */
export function learnedReceiptHash(
	kind: "preference" | "reflection",
	agentId: string,
	requestId: string,
	input: unknown,
	proofs: SourceProof[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				kind,
				agentId,
				requestId,
				input,
				sourceProofs: parseLearnedProofs(proofs),
			}),
		)
		.digest("hex");
}
export function encodeReflectionReceipt(
	agentId: string,
	input: ReflectionInput,
	proofs: SourceProof[],
) {
	return {
		version: 1,
		input,
		provenanceHash: learnedReceiptHash(
			"reflection",
			agentId,
			input.requestId,
			input,
			proofs,
		),
	};
}
export function readReflectionReceipt(
	agentId: string,
	requestId: string,
	inputJson: string,
	proofJson: string,
) {
	const raw = JSON.parse(inputJson),
		sourceProofs = parseLearnedProofs(JSON.parse(proofJson));
	const bound =
		!!raw && typeof raw === "object" && Object.hasOwn(raw, "version");
	if (
		bound &&
		(raw.version !== 1 ||
			Object.keys(raw).sort().join(",") !== "input,provenanceHash,version")
	)
		throw Error("invalid reflection receipt envelope");
	const payload = bound ? raw.input : raw,
		input = validateReflection(payload);
	if (
		!isDeepStrictEqual(payload, input) ||
		input.requestId !== requestId ||
		input.sourceEntryIds.some(
			(id) => !sourceProofs.some((p) => p.entryId === id),
		)
	)
		throw Error("invalid reflection receipt projection");
	if (
		bound &&
		raw.provenanceHash !==
			learnedReceiptHash("reflection", agentId, requestId, input, sourceProofs)
	)
		throw Error("invalid reflection receipt proof integrity");
	return { input, sourceProofs, bound };
}
