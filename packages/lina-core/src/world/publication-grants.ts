import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	canonicalLifeJson,
	digest,
	enumeration,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export const PUBLICATION_GRANTS_SCHEMA: string = `
CREATE TABLE life_publication_grant_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), grant_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
 token_hash TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(world_id,grant_id,revision)
) STRICT;
CREATE TABLE life_publication_grants (
 world_id TEXT NOT NULL REFERENCES worlds(id), grant_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
 token_hash TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(world_id,grant_id),
 UNIQUE(world_id,token_hash),
 FOREIGN KEY(world_id,grant_id,revision) REFERENCES life_publication_grant_history(world_id,grant_id,revision)
) STRICT;
CREATE TABLE life_publication_grant_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL,
 grant_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,grant_id,revision) REFERENCES life_publication_grant_history(world_id,grant_id,revision)
) STRICT;
`;

export interface PublicationViewerGrant {
	version: 1;
	worldId: string;
	id: string;
	recipientId: string;
	revision: number;
	revoked: boolean;
	settingsRevision: number;
}
type MintInput = {
	requestKey: string;
	expectedSettingsRevision: number;
	recipientId: string;
};
type RevokeInput = { requestKey: string; expectedRevision: number };
type GrantRequest =
	| (MintInput & { kind: "mint"; worldId: string })
	| (RevokeInput & { kind: "revoke"; worldId: string; grantId: string });
type GrantRow = {
	world_id: string;
	grant_id: string;
	revision: number;
	grant_json: string;
	token_hash: string;
	digest: string;
};
type ReceiptRow = {
	world_id: string;
	request_key: string;
	grant_id: string;
	revision: number;
	request_json: string;
	request_digest: string;
	digest: string;
};
const TOKEN_FORMAT = /^llv1_[A-Za-z0-9_-]{43}$/;
const TOKEN_LENGTH = 48;
const TOKEN_BYTES = 32;

function parseMint(value: unknown): MintInput {
	jsonBoundary(value);
	fields(value, ["requestKey", "expectedSettingsRevision", "recipientId"]);
	return {
		requestKey: identifier(value.requestKey),
		expectedSettingsRevision: revision(value.expectedSettingsRevision, 1),
		recipientId: identifier(value.recipientId),
	};
}
function parseRevoke(value: unknown): RevokeInput {
	jsonBoundary(value);
	fields(value, ["requestKey", "expectedRevision"]);
	return {
		requestKey: identifier(value.requestKey),
		expectedRevision: revision(value.expectedRevision, 1),
	};
}
function parseRequest(value: unknown): GrantRequest {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "mint"
	) {
		fields(value, [
			"kind",
			"worldId",
			"requestKey",
			"expectedSettingsRevision",
			"recipientId",
		]);
		return {
			kind: "mint",
			worldId: identifier(value.worldId),
			...parseMint({
				requestKey: value.requestKey,
				expectedSettingsRevision: value.expectedSettingsRevision,
				recipientId: value.recipientId,
			}),
		};
	}
	fields(value, [
		"kind",
		"worldId",
		"grantId",
		"requestKey",
		"expectedRevision",
	]);
	return {
		kind: enumeration(value.kind, ["revoke"]),
		worldId: identifier(value.worldId),
		grantId: identifier(value.grantId),
		...parseRevoke({
			requestKey: value.requestKey,
			expectedRevision: value.expectedRevision,
		}),
	};
}
function decode(row: GrantRow): PublicationViewerGrant {
	const value: unknown = JSON.parse(row.grant_json);
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"recipientId",
		"revision",
		"revoked",
		"settingsRevision",
	]);
	if (value.version !== 1) throw Error("Unsupported publication grant version");
	const grant: PublicationViewerGrant = {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		recipientId: identifier(value.recipientId),
		revision: revision(value.revision, 1),
		revoked: flag(value.revoked),
		settingsRevision: revision(value.settingsRevision, 1),
	};
	if (
		grant.worldId !== identifier(row.world_id) ||
		grant.id !== identifier(row.grant_id) ||
		grant.revision !== revision(row.revision, 1) ||
		row.grant_json !== canonicalLifeJson(grant) ||
		digest(row.digest) !==
			lifeDigest({ grant, tokenHash: digest(row.token_hash) })
	)
		throw Error("Corrupt publication grant record");
	return grant;
}

/** WorldStore owns the surrounding transaction and management authorization. */
export class PublicationGrants {
	constructor(
		private readonly db: DatabaseSync,
		private readonly authority: (worldId: string) => {
			settingsRevision: number;
			recipientIds: readonly string[];
		} | null,
	) {}
	mint(
		worldId: string,
		input: MintInput,
	): {
		grant: PublicationViewerGrant;
		token: string | null;
		replayed: boolean;
	} {
		const request: GrantRequest = {
			kind: "mint",
			worldId: identifier(worldId),
			...parseMint(input),
		};
		const replay = this.replay(request);
		if (replay) return { grant: replay, token: null, replayed: true };
		const authority = this.currentAuthority(worldId);
		if (!authority) throw Error("Publication grant authority not configured");
		if (authority.settingsRevision !== request.expectedSettingsRevision)
			throw Error("Publication settings revision conflict");
		if (!authority.recipientIds.includes(request.recipientId))
			throw Error("Publication recipient not configured");
		this.requireWorld(worldId);
		const grant: PublicationViewerGrant = {
			version: 1,
			worldId,
			id: randomUUID(),
			recipientId: request.recipientId,
			revision: 1,
			revoked: false,
			settingsRevision: authority.settingsRevision,
		};
		const token = `llv1_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
		this.save(grant, createHash("sha256").update(token).digest("hex"));
		this.receipt(request, grant);
		return { grant, token, replayed: false };
	}
	revoke(
		worldId: string,
		grantId: string,
		input: RevokeInput,
	): { grant: PublicationViewerGrant; replayed: boolean } {
		const request: GrantRequest = {
			kind: "revoke",
			worldId: identifier(worldId),
			grantId: identifier(grantId),
			...parseRevoke(input),
		};
		const replay = this.replay(request);
		if (replay) return { grant: replay, replayed: true };
		const current = this.read(worldId, grantId);
		if (current.grant.revision !== request.expectedRevision)
			throw Error("Publication grant revision conflict");
		const grant = current.grant.revoked
			? current.grant
			: {
					...current.grant,
					revision: revision(current.grant.revision + 1, 1),
					revoked: true,
				};
		if (!current.grant.revoked) this.save(grant, current.tokenHash);
		this.receipt(request, grant);
		return { grant, replayed: false };
	}
	authenticate(worldId: string, token: string): PublicationViewerGrant | null {
		// Bearer input has one failure result, including invalid world identifiers.
		try {
			identifier(worldId);
		} catch {
			return null;
		}
		if (
			typeof token !== "string" ||
			token.length !== TOKEN_LENGTH ||
			!TOKEN_FORMAT.test(token)
		)
			return null;
		const hash = createHash("sha256").update(token).digest("hex");
		const row = this.db
			.prepare(
				"SELECT grant_id FROM life_publication_grants WHERE world_id=? AND token_hash=?",
			)
			.get(worldId, hash);
		if (!row) return null;
		const current = this.read(worldId, identifier(row["grant_id"]));
		if (
			current.grant.revoked ||
			!timingSafeEqual(
				Buffer.from(hash, "hex"),
				Buffer.from(current.tokenHash, "hex"),
			)
		)
			return null;
		const authority = this.currentAuthority(worldId);
		return authority &&
			authority.settingsRevision >= current.grant.settingsRevision &&
			authority.recipientIds.includes(current.grant.recipientId)
			? current.grant
			: null;
	}
	get(worldId: string, grantId: string): PublicationViewerGrant {
		return this.read(identifier(worldId), identifier(grantId)).grant;
	}
	/** Internal historical source; tokens still authenticate only against the current head. */
	at(
		worldId: string,
		grantId: string,
		atRevision: number,
	): PublicationViewerGrant {
		revision(atRevision, 1);
		this.get(worldId, grantId);
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_grant_history WHERE world_id=? AND grant_id=? AND revision=?",
			)
			.get(worldId, grantId, atRevision) as GrantRow | undefined;
		if (!row) throw Error("Unknown publication grant revision");
		return decode(row);
	}
	validate(): void {
		for (const table of [
			"life_publication_grants",
			"life_publication_grant_history",
			"life_publication_grant_receipts",
		]) {
			if (this.db.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
				throw Error("Orphan publication grant record");
		}
		for (const row of this.db
			.prepare(
				"SELECT world_id,grant_id FROM life_publication_grants UNION SELECT world_id,grant_id FROM life_publication_grant_history UNION SELECT world_id,grant_id FROM life_publication_grant_receipts",
			)
			.all()) {
			const grant = this.get(
				identifier(row["world_id"]),
				identifier(row["grant_id"]),
			);
			const authority = this.currentAuthority(grant.worldId);
			if (authority && authority.settingsRevision < grant.settingsRevision)
				throw Error("Regressed publication grant settings authority");
		}
	}
	private requireWorld(worldId: string): void {
		if (!this.db.prepare("SELECT id FROM worlds WHERE id=?").get(worldId))
			throw Error("Unknown publication grant world");
	}
	private currentAuthority(worldId: string) {
		const value = this.authority(worldId);
		if (value === null) return null;
		jsonBoundary(value);
		fields(value, ["settingsRevision", "recipientIds"]);
		return {
			settingsRevision: revision(value.settingsRevision, 1),
			recipientIds: identifiers(value.recipientIds),
		};
	}
	private read(worldId: string, grantId: string) {
		this.requireWorld(worldId);
		const head = this.db
			.prepare(
				"SELECT * FROM life_publication_grants WHERE world_id=? AND grant_id=?",
			)
			.get(worldId, grantId) as GrantRow | undefined;
		const rows = this.db
			.prepare(
				"SELECT * FROM life_publication_grant_history WHERE world_id=? AND grant_id=? ORDER BY revision",
			)
			.all(worldId, grantId) as GrantRow[];
		if (!head || !rows.length)
			throw Error("Missing publication grant head or history");
		const history = rows.map(decode);
		const first = history[0];
		if (!first || first.revoked || first.revision !== 1 || rows.length > 2)
			throw Error("Corrupt publication grant history");
		for (const [index, grant] of history.entries()) {
			if (
				grant.revision !== index + 1 ||
				canonicalLifeJson(grant) !==
					canonicalLifeJson({
						...first,
						revision: index + 1,
						revoked: index > 0,
					}) ||
				rows[index]?.token_hash !== head.token_hash
			)
				throw Error("Corrupt publication grant transition");
		}
		const grant = decode(head);
		if (canonicalLifeJson(grant) !== canonicalLifeJson(history.at(-1)))
			throw Error("Regressed publication grant head");
		this.auditReceipts(worldId, grantId, history);
		return { grant, tokenHash: head.token_hash };
	}
	private auditReceipts(
		worldId: string,
		grantId: string,
		history: PublicationViewerGrant[],
	): void {
		const mutations = new Set<number>();
		for (const row of this.db
			.prepare(
				"SELECT * FROM life_publication_grant_receipts WHERE world_id=? AND grant_id=?",
			)
			.all(worldId, grantId) as ReceiptRow[]) {
			const request = parseRequest(JSON.parse(row.request_json));
			const grant = history[revision(row.revision, 1) - 1];
			if (
				!grant ||
				request.worldId !== identifier(row.world_id) ||
				request.requestKey !== identifier(row.request_key) ||
				grant.id !== identifier(row.grant_id) ||
				row.request_json !== canonicalLifeJson(request) ||
				digest(row.request_digest) !== lifeDigest(request) ||
				digest(row.digest) !== lifeDigest({ request, grant })
			)
				throw Error("Corrupt publication grant receipt");
			if (request.kind === "mint") {
				if (
					grant.revision !== 1 ||
					grant.revoked ||
					request.recipientId !== grant.recipientId ||
					request.expectedSettingsRevision !== grant.settingsRevision
				)
					throw Error("Corrupt publication mint receipt");
			} else if (
				request.grantId !== grant.id ||
				!grant.revoked ||
				grant.revision !== 2 ||
				![1, 2].includes(request.expectedRevision)
			)
				throw Error("Corrupt publication revoke receipt");
			if (request.kind === "mint" || request.expectedRevision === 1) {
				if (mutations.has(grant.revision))
					throw Error("Duplicate publication grant mutation receipt");
				mutations.add(grant.revision);
			}
		}
		if (mutations.size !== history.length)
			throw Error("Missing publication grant mutation receipt");
	}
	private replay(request: GrantRequest): PublicationViewerGrant | null {
		const row = this.db
			.prepare(
				"SELECT grant_id,request_digest FROM life_publication_grant_receipts WHERE world_id=? AND request_key=?",
			)
			.get(request.worldId, request.requestKey);
		if (!row) return null;
		const grant = this.get(request.worldId, identifier(row["grant_id"]));
		if (row["request_digest"] !== lifeDigest(request))
			throw Error("Publication grant request conflict");
		return grant;
	}
	private save(grant: PublicationViewerGrant, tokenHash: string): void {
		const json = canonicalLifeJson(grant),
			hash = lifeDigest({ grant, tokenHash });
		this.db
			.prepare(
				"INSERT INTO life_publication_grant_history(world_id,grant_id,revision,grant_json,token_hash,digest) VALUES(?,?,?,?,?,?)",
			)
			.run(grant.worldId, grant.id, grant.revision, json, tokenHash, hash);
		if (grant.revision === 1) {
			this.db
				.prepare(
					"INSERT INTO life_publication_grants(world_id,grant_id,revision,grant_json,token_hash,digest) VALUES(?,?,?,?,?,?)",
				)
				.run(grant.worldId, grant.id, grant.revision, json, tokenHash, hash);
		} else {
			const result = this.db
				.prepare(
					"UPDATE life_publication_grants SET revision=?,grant_json=?,digest=? WHERE world_id=? AND grant_id=? AND revision=?",
				)
				.run(
					grant.revision,
					json,
					hash,
					grant.worldId,
					grant.id,
					grant.revision - 1,
				);
			if (result.changes !== 1)
				throw Error("Publication grant revision conflict");
		}
	}
	private receipt(request: GrantRequest, grant: PublicationViewerGrant): void {
		this.db
			.prepare(
				"INSERT INTO life_publication_grant_receipts(world_id,request_key,grant_id,revision,request_json,request_digest,digest) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				grant.worldId,
				request.requestKey,
				grant.id,
				grant.revision,
				canonicalLifeJson(request),
				lifeDigest(request),
				lifeDigest({ request, grant }),
			);
	}
}
