import { isDeepStrictEqual } from "node:util";
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
	return {
		entryId: part.entryId,
		partIndex: part.partIndex,
		contentHash: part.contentHash,
	};
}

export function parseRemoteMessage(value: unknown): RemoteMessage {
	const message = object(value, "message");
	const metadata = object(message["metadata"], "message metadata");
	const lina = object(metadata["lina"], "message metadata.lina");
	if (
		!isDeepStrictEqual(Object.keys(lina).sort(), [
			"contentHash",
			"entryId",
			"partIndex",
		])
	)
		throw new HonchoRequestError(
			"honcho metadata.lina has unexpected keys",
			"body",
		);
	if (!Number.isSafeInteger(lina["partIndex"]))
		throw new HonchoRequestError(
			"honcho metadata.lina.partIndex invalid",
			"body",
		);
	return {
		id: string(message["id"], "message id"),
		workspaceId: string(message["workspace_id"], "workspace_id"),
		sessionId: string(message["session_id"], "session_id"),
		peerId: string(message["peer_id"], "peer_id"),
		content:
			typeof message["content"] === "string"
				? message["content"]
				: string(undefined, "content"),
		key: {
			entryId: string(lina["entryId"], "entryId"),
			partIndex: lina["partIndex"] as number,
			contentHash: string(lina["contentHash"], "contentHash"),
		},
	};
}
