import type { DatabaseSync } from "node:sqlite";
import {
	canonicalLifeJson,
	enumeration,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { PublicationFeed } from "./publication-feed.ts";
import type { PublicationPrincipal } from "./publication-types.ts";
import { fields } from "./validation.ts";

export const PUBLICATION_CURSORS_SCHEMA = `
CREATE TABLE life_publication_cursor_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,principal_key,revision)
) STRICT;
CREATE TABLE life_publication_cursors (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,principal_key),
 FOREIGN KEY(world_id,principal_key,revision) REFERENCES life_publication_cursor_history(world_id,principal_key,revision)
) STRICT;
`;
type Cursor = {
	version: 1;
	worldId: string;
	principal: PublicationPrincipal;
	revision: number;
	postId: string;
};
type Row = {
	world_id: string;
	principal_key: string;
	revision: number;
	cursor_json: string;
	digest: string;
};
function principal(value: unknown): PublicationPrincipal {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "viewer"
	) {
		fields(value, ["kind", "grantId"]);
		return { kind: "viewer", grantId: identifier(value.grantId) };
	}
	fields(value, ["kind", "agentId"]);
	return {
		kind: enumeration(value.kind, ["agent"]),
		agentId: identifier(value.agentId),
	};
}
function key(value: PublicationPrincipal) {
	return lifeDigest(principal(value));
}
function decode(row: Row): Cursor {
	const value: unknown = JSON.parse(row.cursor_json);
	jsonBoundary(value);
	fields(value, ["version", "worldId", "principal", "revision", "postId"]);
	if (value.version !== 1)
		throw Error("Unsupported publication cursor version");
	const result: Cursor = {
		version: 1,
		worldId: identifier(value.worldId),
		principal: principal(value.principal),
		revision: revision(value.revision, 1),
		postId: identifier(value.postId),
	};
	if (
		result.worldId !== row.world_id ||
		key(result.principal) !== row.principal_key ||
		result.revision !== row.revision ||
		lifeDigest(result) !== row.digest
	)
		throw Error("Corrupt publication read cursor");
	return result;
}
/** Explicit read-state mutations never admit observations or start world work. */
export class PublicationCursors {
	constructor(
		private readonly db: DatabaseSync,
		private readonly feed: PublicationFeed,
	) {}
	private read(worldId: string, scope: PublicationPrincipal): Cursor | null {
		return this.readKey(identifier(worldId), key(scope));
	}
	private readKey(worldId: string, principalKey: string): Cursor | null {
		const head = this.db
			.prepare(
				"SELECT * FROM life_publication_cursors WHERE world_id=? AND principal_key=?",
			)
			.get(worldId, principalKey) as Row | undefined;
		const history = (
			this.db
				.prepare(
					"SELECT * FROM life_publication_cursor_history WHERE world_id=? AND principal_key=? ORDER BY revision",
				)
				.all(worldId, principalKey) as Row[]
		).map(decode);
		if (!head && !history.length) return null;
		if (
			!head ||
			history.some((c, i) => c.revision !== i + 1) ||
			lifeDigest(decode(head)) !== lifeDigest(history.at(-1))
		)
			throw Error("Missing or regressed publication read cursor history");
		return decode(head);
	}
	get(
		worldId: string,
		scope: PublicationPrincipal,
	): { revision: number; postId: string | null } {
		this.feed.recipient(worldId, scope);
		const cursor = this.read(worldId, scope);
		return {
			revision: cursor?.revision ?? 0,
			postId:
				cursor && this.feed.post(worldId, scope, cursor.postId)
					? cursor.postId
					: null,
		};
	}
	set(
		worldId: string,
		scope: PublicationPrincipal,
		input: { expectedRevision: number; postId: string },
	): { revision: number; postId: string } {
		jsonBoundary(input);
		fields(input, ["expectedRevision", "postId"]);
		revision(input.expectedRevision);
		identifier(input.postId);
		this.feed.recipient(worldId, scope);
		const current = this.read(worldId, scope);
		if ((current?.revision ?? 0) !== input.expectedRevision)
			throw Error("Publication cursor revision conflict");
		if (!this.feed.post(worldId, scope, input.postId))
			throw Error("Publication cursor post unavailable");
		if (current?.postId === input.postId)
			return { revision: current.revision, postId: current.postId };
		const next: Cursor = {
				version: 1,
				worldId,
				principal: principal(scope),
				revision: revision(input.expectedRevision + 1, 1),
				postId: input.postId,
			},
			json = canonicalLifeJson(next),
			digest = lifeDigest(next),
			principalKey = key(scope);
		this.db
			.prepare(
				"INSERT INTO life_publication_cursor_history(world_id,principal_key,revision,cursor_json,digest) VALUES(?,?,?,?,?)",
			)
			.run(worldId, principalKey, next.revision, json, digest);
		this.db
			.prepare(
				"INSERT INTO life_publication_cursors(world_id,principal_key,revision,cursor_json,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,principal_key) DO UPDATE SET revision=excluded.revision,cursor_json=excluded.cursor_json,digest=excluded.digest",
			)
			.run(worldId, principalKey, next.revision, json, digest);
		return { revision: next.revision, postId: next.postId };
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id,principal_key FROM life_publication_cursors UNION SELECT world_id,principal_key FROM life_publication_cursor_history",
			)
			.all()) {
			const cursor = this.readKey(
				String(row["world_id"]),
				String(row["principal_key"]),
			);
			if (!cursor) throw Error("Missing publication cursor");
			for (const historical of this.db
				.prepare(
					"SELECT cursor_json FROM life_publication_cursor_history WHERE world_id=? AND principal_key=?",
				)
				.all(cursor.worldId, key(cursor.principal))) {
				const value = JSON.parse(String(historical["cursor_json"]));
				if (
					!this.db
						.prepare(
							"SELECT 1 FROM life_publication_posts WHERE world_id=? AND post_id=? UNION ALL SELECT 1 FROM life_publication_reply_posts WHERE world_id=? AND post_id=?",
						)
						.get(cursor.worldId, value.postId, cursor.worldId, value.postId)
				)
					throw Error("Missing publication cursor post history");
			}
		}
	}
}
