import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateBinding } from "../../../lina-core/src/session-binding.ts";
import {
	parseSourceProof,
	type SourceLookup,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import {
	publicIdentity,
	validateHonchoConfig,
	validateOrdinaryNamespace,
} from "./config.ts";
import { object } from "./messages.ts";
import {
	type BotBinding,
	type GenerationOwner,
	type HonchoConfig,
	HonchoRequestError,
	type NamespaceProof,
	type RecallProof,
} from "./types.ts";

export function generationOwner(
	binding: BotBinding,
	config: HonchoConfig,
): GenerationOwner {
	const checked = validateHonchoConfig(config);
	const ordinaryNamespace = checked.ordinaryNamespace;
	if (!ordinaryNamespace || ordinaryNamespace.ownerBotId !== binding.botId)
		throw new HonchoRequestError(
			"honcho qualification owner unavailable",
			"body",
		);
	return {
		binding: validateBinding(binding),
		identity: publicIdentity(checked),
		ordinaryNamespace,
	};
}

export function generationDigest(owner: GenerationOwner): string {
	// Reconstruct all fields so caller object insertion order cannot select a path.
	const namespace = validateOrdinaryNamespace(owner.ordinaryNamespace);
	const binding = validateBinding(owner.binding);
	const identity = owner.identity;
	if (
		namespace.ownerBotId !== binding.botId ||
		["workspaceId", "sessionId", "userPeerId", "observerPeerId"].some(
			(k) =>
				identity[k as keyof typeof identity] !==
				namespace[k as keyof typeof namespace],
		)
	)
		throw new Error("invalid honcho generation owner");
	return createHash("sha256")
		.update(
			JSON.stringify({
				binding: {
					version: binding.version,
					botId: binding.botId,
					sessionId: binding.sessionId,
					sessionFile: binding.sessionFile,
					workspace: binding.workspace,
				},
				identity: {
					baseUrl: identity.baseUrl,
					workspaceId: identity.workspaceId,
					sessionId: identity.sessionId,
					userPeerId: identity.userPeerId,
					observerPeerId: identity.observerPeerId,
				},
				ordinaryNamespace: namespace,
			}),
		)
		.digest("hex");
}

export function validateNamespaceProof(
	value: unknown,
	owner: GenerationOwner,
	recall = false,
): NamespaceProof {
	const proof = object(value, "qualification proof");
	const keys = [
		"version",
		"owner",
		"isolation",
		"ordinaryOnly",
		...(recall ? ["sourceProofs"] : []),
	];
	if (
		Object.keys(proof).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(proof, k)) ||
		proof["version"] !== 1 ||
		proof["isolation"] !== "workspace" ||
		proof["ordinaryOnly"] !== true ||
		!isDeepStrictEqual(proof["owner"], owner)
	)
		throw new HonchoRequestError(
			"honcho qualification proof does not match owner or namespace",
			"body",
		);
	return {
		version: 1,
		owner: structuredClone(owner),
		isolation: "workspace",
		ordinaryOnly: true,
	};
}

export function validateRecallProof(
	value: unknown,
	owner: GenerationOwner,
	lookup: SourceLookup,
): RecallProof {
	const proof = validateNamespaceProof(value, owner, true);
	const input = object(value, "recall proof")["sourceProofs"];
	if (!Array.isArray(input) || !sourceProofsCurrent(input, lookup))
		throw new HonchoRequestError(
			"honcho recall provenance is not current ordinary source",
			"body",
		);
	return { ...proof, sourceProofs: input.map(parseSourceProof) };
}
