import { parseSourceProof } from "../../../lina-core/src/source-policy.ts";
import { validateOrdinaryNamespace } from "./config.ts";
import {
	HonchoRequestError,
	type PartKey,
	type RemoteMessage,
} from "./types.ts";

export type Json = Record<string, unknown>;

export function object(value: unknown, what: string): Json {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new HonchoRequestError(`honcho ${what} is not an object`, "body");
	return value as Json;
}

export function string(value: unknown, what: string): string {
	if (typeof value !== "string" || !value || value.includes("\0"))
		throw new HonchoRequestError(`honcho ${what} is not a string`, "body");
	return value;
}

export function partKey(part: PartKey): PartKey {
	return parsePartKey({
		entryId: part.entryId,
		partIndex: part.partIndex,
		contentHash: part.contentHash,
		...(part.version !== undefined
			? {
					version: part.version,
					sourceProofs: part.sourceProofs,
					policyScope: part.policyScope,
				}
			: {}),
	});
}

export function parsePartKey(value: unknown): PartKey {
	const lina = object(value, "metadata.lina");
	const qualified = lina["version"] !== undefined;
	const keys = [
		"entryId",
		"partIndex",
		"contentHash",
		...(qualified ? ["version", "sourceProofs", "policyScope"] : []),
	];
	if (
		Object.keys(lina).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(lina, key))
	)
		throw new HonchoRequestError(
			"honcho metadata.lina has unexpected keys",
			"body",
		);
	if (
		!Number.isSafeInteger(lina["partIndex"]) ||
		(lina["partIndex"] as number) < 0
	)
		throw new HonchoRequestError(
			"honcho metadata.lina.partIndex invalid",
			"body",
		);
	const key: PartKey = {
		entryId: string(lina["entryId"], "entryId"),
		partIndex: lina["partIndex"] as number,
		contentHash: string(lina["contentHash"], "contentHash"),
	};
	if (qualified) {
		const proofs = lina["sourceProofs"];
		if (
			lina["version"] !== 2 ||
			!Array.isArray(proofs) ||
			!proofs.length ||
			proofs.length > 65536 ||
			!/^[a-f0-9]{64}$/.test(key.contentHash)
		)
			throw new HonchoRequestError("honcho capture provenance invalid", "body");
		key.version = 2;
		key.sourceProofs = proofs
			.map(parseSourceProof)
			.sort((a, b) => a.entryId.localeCompare(b.entryId));
		if (
			new Set(key.sourceProofs.map((p) => p.entryId)).size !== proofs.length ||
			!key.sourceProofs.some((p) => p.entryId === key.entryId)
		)
			throw new HonchoRequestError(
				"honcho capture provenance missing or duplicate source",
				"body",
			);
		key.policyScope = validateOrdinaryNamespace(lina["policyScope"]);
	}
	return key;
}

export function parseRemoteMessage(value: unknown): RemoteMessage {
	const message = object(value, "message");
	const metadata = object(message["metadata"], "message metadata");
	const key = parsePartKey(metadata["lina"]);
	return {
		id: string(message["id"], "message id"),
		workspaceId: string(message["workspace_id"], "workspace_id"),
		sessionId: string(message["session_id"], "session_id"),
		peerId: string(message["peer_id"], "peer_id"),
		content:
			typeof message["content"] === "string"
				? message["content"]
				: string(undefined, "content"),
		key,
	};
}
