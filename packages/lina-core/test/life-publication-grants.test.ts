import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	PUBLICATION_GRANTS_SCHEMA,
	PublicationGrants,
} from "../src/world/publication-grants.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
const mintInput = {
	requestKey: "mint-1",
	expectedSettingsRevision: 1,
	recipientId: "friends",
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-grants-"));
	const path = join(root, "world.sqlite");
	let db = new DatabaseSync(path);
	cleanup.push(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT");
	db.exec("INSERT INTO worlds VALUES('world'),('other')");
	db.exec(PUBLICATION_GRANTS_SCHEMA);
	const authorities = new Map([
		["world", { settingsRevision: 1, recipientIds: ["friends", "family"] }],
		["other", { settingsRevision: 1, recipientIds: ["friends"] }],
	]);
	const authority = (worldId: string) => authorities.get(worldId) ?? null;
	let grants = new PublicationGrants(db, authority);
	return {
		path,
		authorities,
		get db() {
			return db;
		},
		get grants() {
			return grants;
		},
		transaction<T>(action: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = action();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			grants = new PublicationGrants(db, authority);
			grants.validate();
		},
	};
}

test("mint returns a world-bound opaque token once and only its hash survives file reopen", () => {
	const f = fixture();
	const result = f.transaction(() => f.grants.mint("world", mintInput));
	expect(result.replayed).toBe(false);
	if (!result.token) throw Error("Missing minted capability");
	expect(/^llv1_[A-Za-z0-9_-]{43}$/.test(result.token)).toBe(true);
	expect(Buffer.from(result.token.slice(5), "base64url").length).toBe(32);
	const hash = createHash("sha256").update(result.token).digest("hex");
	expect(result.grant.id.includes(hash)).toBe(false);
	expect(result.grant).toEqual({
		version: 1,
		worldId: "world",
		id: result.grant.id,
		recipientId: "friends",
		revision: 1,
		revoked: false,
		settingsRevision: 1,
	});
	expect(JSON.stringify(result.grant).includes(hash)).toBe(false);
	expect(f.grants.authenticate("world", result.token)).toEqual(result.grant);
	expect(f.grants.authenticate("other", result.token)).toBeNull();
	f.reopen();
	expect(f.grants.authenticate("world", result.token)).toEqual(result.grant);
	expect(readFileSync(f.path).includes(Buffer.from(result.token))).toBe(false);
	expect(readFileSync(f.path).includes(Buffer.from(hash))).toBe(true);
	expect(f.transaction(() => f.grants.mint("world", mintInput))).toEqual({
		grant: result.grant,
		token: null,
		replayed: true,
	});
	expect(() =>
		f.transaction(() =>
			f.grants.mint("world", {
				...mintInput,
				recipientId: "family",
			}),
		),
	).toThrow(/conflict/i);
});

test("mint requires explicit current settings and a configured recipient", () => {
	const f = fixture();
	for (const input of [
		{ ...mintInput, expectedSettingsRevision: 0 },
		{ ...mintInput, expectedSettingsRevision: 2 },
		{ ...mintInput, recipientId: "stranger" },
	])
		expect(() => f.transaction(() => f.grants.mint("world", input))).toThrow();
	f.authorities.delete("world");
	expect(() =>
		f.transaction(() => f.grants.mint("world", mintInput)),
	).toThrow();
	expect(() =>
		f.transaction(() => f.grants.mint("unknown", mintInput)),
	).toThrow();
	f.reopen();
	expect(
		f.db.prepare("SELECT count(*) AS n FROM life_publication_grants").get()?.[
			"n"
		],
	).toBe(0);
});

test("authentication rechecks current eligibility without expiring valid grants on settings edits", () => {
	const f = fixture();
	const { grant, token } = f.transaction(() =>
		f.grants.mint("world", mintInput),
	);
	if (!token) throw Error("Missing minted capability");
	f.authorities.set("world", {
		settingsRevision: 2,
		recipientIds: ["friends"],
	});
	expect(f.grants.authenticate("world", token)).toEqual(grant);
	f.authorities.set("world", { settingsRevision: 3, recipientIds: ["family"] });
	expect(f.grants.authenticate("world", token)).toBeNull();
	f.reopen();
	expect(f.grants.authenticate("world", token)).toBeNull();
	f.authorities.delete("world");
	expect(f.grants.authenticate("world", token)).toBeNull();
	expect(f.transaction(() => f.grants.mint("world", mintInput))).toEqual({
		grant,
		token: null,
		replayed: true,
	});
});

test("revoke uses CAS and durable receipts; old requests replay current revoked metadata", () => {
	const f = fixture();
	const { grant, token } = f.transaction(() =>
		f.grants.mint("world", mintInput),
	);
	if (!token) throw Error("Missing minted capability");
	const input = { requestKey: "revoke-1", expectedRevision: 1 };
	expect(() =>
		f.transaction(() => f.grants.revoke("other", grant.id, input)),
	).toThrow();
	expect(() =>
		f.transaction(() =>
			f.grants.revoke("world", grant.id, { ...input, expectedRevision: 2 }),
		),
	).toThrow(/conflict/i);
	const revoked = f.transaction(() =>
		f.grants.revoke("world", grant.id, input),
	);
	expect(revoked).toEqual({
		grant: { ...grant, revision: 2, revoked: true },
		replayed: false,
	});
	expect(f.grants.authenticate("world", token)).toBeNull();
	f.reopen();
	expect(
		f.transaction(() => f.grants.revoke("world", grant.id, input)),
	).toEqual({ ...revoked, replayed: true });
	expect(f.transaction(() => f.grants.mint("world", mintInput))).toEqual({
		grant: revoked.grant,
		token: null,
		replayed: true,
	});
	expect(() =>
		f.transaction(() =>
			f.grants.revoke("world", grant.id, { ...input, expectedRevision: 2 }),
		),
	).toThrow(/conflict/i);
	expect(() =>
		f.transaction(() =>
			f.grants.revoke("world", grant.id, { ...input, requestKey: "stale" }),
		),
	).toThrow(/conflict/i);
	const noOp = { requestKey: "revoke-again", expectedRevision: 2 };
	expect(f.transaction(() => f.grants.revoke("world", grant.id, noOp))).toEqual(
		revoked,
	);
	f.reopen();
	expect(
		f.transaction(() => f.grants.revoke("world", grant.id, noOp)).replayed,
	).toBe(true);
	expect(f.grants.get("world", grant.id)).toEqual(revoked.grant);
});

test("request keys bind operation and grant within a world, and repeat on another connection", () => {
	const f = fixture();
	const first = f.transaction(() => f.grants.mint("world", mintInput));
	const other = f.transaction(() => f.grants.mint("other", mintInput));
	expect(first.grant.id === other.grant.id).toBe(false);
	expect(first.token === other.token).toBe(false);
	expect(() =>
		f.transaction(() =>
			f.grants.revoke("world", first.grant.id, {
				requestKey: mintInput.requestKey,
				expectedRevision: 1,
			}),
		),
	).toThrow(/conflict/i);
	const second = new DatabaseSync(f.path);
	try {
		second.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
		const grants = new PublicationGrants(
			second,
			(id) => f.authorities.get(id) ?? null,
		);
		expect(grants.mint("world", mintInput)).toEqual({
			grant: first.grant,
			token: null,
			replayed: true,
		});
		second.exec("COMMIT");
		grants.validate();
	} finally {
		second.close();
	}
});

test("untrusted inputs reject exact-shape violations before executing accessors or writing", () => {
	const f = fixture();
	let getterCalls = 0;
	const getter = Object.defineProperty({ ...mintInput }, "recipientId", {
		enumerable: true,
		get() {
			getterCalls++;
			return "friends";
		},
	});
	const invalid: unknown[] = [
		null,
		[],
		Object.create(mintInput),
		getter,
		{ ...mintInput, extra: true },
		{ ...mintInput, [Symbol("extra")]: true },
		Object.defineProperty({ ...mintInput }, "hidden", { value: true }),
		{ ...mintInput, requestKey: "a".repeat(129) },
		{ ...mintInput, recipientId: "../friends" },
		{ ...mintInput, expectedSettingsRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...mintInput, expectedSettingsRevision: 1.5 },
		{ ...mintInput, expectedSettingsRevision: Infinity },
	];
	for (const input of invalid)
		expect(() =>
			f.transaction(() => f.grants.mint("world", input as typeof mintInput)),
		).toThrow();
	expect(getterCalls).toBe(0);
	for (const world of ["", "world/other", "a".repeat(129)]) {
		expect(() => f.grants.get(world, "grant")).toThrow();
		expect(() => f.grants.mint(world, mintInput)).toThrow();
		expect(f.grants.authenticate(world, `llv1_${"a".repeat(43)}`)).toBeNull();
	}
	const { grant } = f.transaction(() => f.grants.mint("world", mintInput));
	for (const input of [
		null,
		[],
		{ requestKey: "r", expectedRevision: 1, extra: true },
		{ requestKey: "r", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ requestKey: "r", expectedRevision: 0 },
		{ requestKey: "r", expectedRevision: 1.1 },
	])
		expect(() =>
			f.grants.revoke(
				"world",
				grant.id,
				input as { requestKey: string; expectedRevision: number },
			),
		).toThrow();
	f.reopen();
});

test("invalid, guessed and revoked bearers return the same null result", () => {
	const f = fixture();
	for (const token of [
		null,
		{},
		4,
		"",
		"llv1_bad",
		`llv1_${"a".repeat(43)}`,
		`llv1_${"a".repeat(42)}`,
		`llv1_${"a".repeat(44)}`,
		`llv1_${"/".repeat(43)}`,
		`Bearer llv1_${"a".repeat(43)}`,
		`llv1_${"a".repeat(43)}\n`,
	])
		expect(f.grants.authenticate("world", token as string)).toBeNull();
});

test("caller rollback removes the head, history and receipt after a failed enclosing write", () => {
	const f = fixture();
	expect(() =>
		f.transaction(() => {
			f.grants.mint("world", mintInput);
			throw Error("synthetic enclosing failure");
		}),
	).toThrow("synthetic enclosing failure");
	f.reopen();
	expect(f.transaction(() => f.grants.mint("world", mintInput)).replayed).toBe(
		false,
	);
});

test("receipt insertion failure rolls back mint and revoke with no stranded mutation", () => {
	const f = fixture();
	const { grant, token } = f.transaction(() =>
		f.grants.mint("world", mintInput),
	);
	if (!token) throw Error("Missing minted capability");
	f.db.exec(`CREATE TRIGGER fail_publication_receipt BEFORE INSERT ON life_publication_grant_receipts
		BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`);
	expect(() =>
		f.transaction(() =>
			f.grants.mint("world", {
				...mintInput,
				requestKey: "second-mint",
			}),
		),
	).toThrow("synthetic receipt failure");
	expect(() =>
		f.transaction(() =>
			f.grants.revoke("world", grant.id, {
				requestKey: "revoke-1",
				expectedRevision: 1,
			}),
		),
	).toThrow("synthetic receipt failure");
	f.db.exec("DROP TRIGGER fail_publication_receipt");
	f.reopen();
	expect(f.grants.get("world", grant.id)).toEqual(grant);
	expect(f.grants.authenticate("world", token)).toEqual(grant);
	expect(
		f.transaction(() =>
			f.grants.mint("world", {
				...mintInput,
				requestKey: "second-mint",
			}),
		).replayed,
	).toBe(false);
});

test("128-character identifiers and the maximum safe settings revision survive reopen", () => {
	const f = fixture();
	const recipient = "r".repeat(128);
	f.authorities.set("world", {
		settingsRevision: Number.MAX_SAFE_INTEGER,
		recipientIds: [recipient],
	});
	const { grant, token } = f.transaction(() =>
		f.grants.mint("world", {
			requestKey: "k".repeat(128),
			recipientId: recipient,
			expectedSettingsRevision: Number.MAX_SAFE_INTEGER,
		}),
	);
	if (!token) throw Error("Missing minted capability");
	f.reopen();
	expect(f.grants.get("world", grant.id)).toEqual(grant);
	expect(f.grants.authenticate("world", token)).toEqual(grant);
	f.authorities.set("world", {
		settingsRevision: 1,
		recipientIds: [recipient],
	});
	expect(f.grants.authenticate("world", token)).toBeNull();
	expect(() => f.reopen()).toThrow(/regressed/i);
});

test("get, authenticate and successful replay are read-only and return detached metadata", () => {
	const f = fixture();
	const { grant, token } = f.transaction(() =>
		f.grants.mint("world", mintInput),
	);
	if (!token) throw Error("Missing minted capability");
	const before = f.db.prepare("SELECT total_changes() AS n").get();
	f.grants.get("world", grant.id).recipientId = "stranger";
	expect(f.grants.authenticate("world", token)).toEqual(grant);
	f.transaction(() => f.grants.mint("world", mintInput));
	expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	f.reopen();
	expect(f.grants.get("world", grant.id)).toEqual(grant);
});

test("receipt replay cannot move a revoke request to another grant", () => {
	const f = fixture();
	const first = f.transaction(() => f.grants.mint("world", mintInput));
	const second = f.transaction(() =>
		f.grants.mint("world", { ...mintInput, requestKey: "mint-2" }),
	);
	const input = { requestKey: "revoke-1", expectedRevision: 1 };
	f.transaction(() => f.grants.revoke("world", first.grant.id, input));
	expect(() =>
		f.transaction(() => f.grants.revoke("world", second.grant.id, input)),
	).toThrow(/conflict/i);
	f.reopen();
	expect(f.grants.get("world", second.grant.id).revoked).toBe(false);
});

// Rehash valid JSON independently to exercise transition and shape validation.
for (const [label, change] of [
	["recipient substitution", { recipientId: "family" }],
	["revocation reversal", { revoked: false }],
	["unknown field", { extension: true }],
	["unknown version", { version: 2 }],
	["unsafe number", { settingsRevision: Number.MAX_SAFE_INTEGER + 1 }],
] as const)
	test(`reopen rejects rehashed ${label}`, () => {
		const f = fixture();
		const { grant } = f.transaction(() => f.grants.mint("world", mintInput));
		f.transaction(() =>
			f.grants.revoke("world", grant.id, {
				requestKey: "revoke-1",
				expectedRevision: 1,
			}),
		);
		const row = f.db
			.prepare(
				"SELECT grant_json,token_hash FROM life_publication_grant_history WHERE revision=2",
			)
			.get();
		if (!row) throw Error("Missing test history");
		const changed = { ...JSON.parse(String(row["grant_json"])), ...change };
		const json = JSON.stringify(changed, Object.keys(changed).sort());
		const hash = createHash("sha256")
			.update(
				`{"grant":${json},"tokenHash":${JSON.stringify(row["token_hash"])}}`,
			)
			.digest("hex");
		f.db
			.prepare(
				"UPDATE life_publication_grant_history SET grant_json=?,digest=? WHERE revision=2",
			)
			.run(json, hash);
		f.db
			.prepare("UPDATE life_publication_grants SET grant_json=?,digest=?")
			.run(json, hash);
		expect(() => f.reopen()).toThrow();
	});

const corruptions = [
	["missing head", "DELETE FROM life_publication_grants"],
	["missing history", "DELETE FROM life_publication_grant_history"],
	[
		"missing mint receipt",
		"DELETE FROM life_publication_grant_receipts WHERE request_key='mint-1'",
	],
	[
		"missing revoke receipt",
		"DELETE FROM life_publication_grant_receipts WHERE request_key='revoke-1'",
	],
	[
		"regressed head",
		"UPDATE life_publication_grants SET revision=1,grant_json=(SELECT grant_json FROM life_publication_grant_history WHERE revision=1),digest=(SELECT digest FROM life_publication_grant_history WHERE revision=1)",
	],
	[
		"unknown metadata field",
		"UPDATE life_publication_grants SET grant_json=json_set(grant_json,'$.extra',true)",
	],
	[
		"unsafe revision",
		"UPDATE life_publication_grants SET revision=9007199254740992",
	],
	[
		"unsafe settings revision",
		"UPDATE life_publication_grant_history SET grant_json=json_set(grant_json,'$.settingsRevision',9007199254740992)",
	],
	["invalid digest", "UPDATE life_publication_grants SET digest='bad'"],
	[
		"changed token hash",
		"UPDATE life_publication_grants SET token_hash=printf('%064d',0)",
	],
	[
		"unknown request field",
		"UPDATE life_publication_grant_receipts SET request_json=json_set(request_json,'$.extra',true)",
	],
	[
		"changed request digest",
		"UPDATE life_publication_grant_receipts SET request_digest=printf('%064d',0)",
	],
	[
		"changed receipt digest",
		"UPDATE life_publication_grant_receipts SET digest=printf('%064d',0)",
	],
	[
		"receipt key mismatch",
		"UPDATE life_publication_grant_receipts SET request_key='wrong' WHERE request_key='mint-1'",
	],
	[
		"receipt result mismatch",
		"UPDATE life_publication_grant_receipts SET revision=2 WHERE request_key='mint-1'",
	],
	["foreign world", "DELETE FROM worlds WHERE id='world'"],
	[
		"cross-world history",
		"UPDATE life_publication_grant_history SET world_id='other' WHERE revision=1",
	],
] as const;
for (const [label, sql] of corruptions)
	test(`actual reopen rejects ${label}`, () => {
		const f = fixture();
		const { grant } = f.transaction(() => f.grants.mint("world", mintInput));
		f.transaction(() =>
			f.grants.revoke("world", grant.id, {
				requestKey: "revoke-1",
				expectedRevision: 1,
			}),
		);
		f.reopen();
		f.db.exec("PRAGMA foreign_keys=OFF");
		f.db.exec(sql);
		expect(() => f.reopen()).toThrow();
	});
