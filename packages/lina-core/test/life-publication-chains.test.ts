import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	canonicalLifeJson,
	lifeDigest,
	MAX_LIFE_ITEMS,
} from "../src/world/life-json.ts";
import {
	PUBLICATION_CHAINS_SCHEMA,
	type PublicationChainRef,
	type PublicationChainSnapshot,
	PublicationChains,
	parsePublicationChainSnapshot,
} from "../src/world/publication-chains.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
const limits = {
	maxChainDepth: 3,
	maxActionsPerChain: 3,
	perAuthorCooldownSteps: 2,
};
const root = [{ rootId: "root", depth: 0 }];
const charged = { charged: true, replayed: false };
const denied = { charged: false, replayed: false };
const replayed = { charged: true, replayed: true };
const tables = [
	"life_publication_chain_state",
	"life_publication_chain_actions",
	"life_publication_chain_roots",
	"life_publication_chain_charges",
] as const;

function transaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "lina-publication-chains-"));
	const path = join(directory, "world.sqlite");
	let db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
	db.exec("CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT");
	db.exec("INSERT INTO worlds VALUES('world'),('other')");
	db.exec(PUBLICATION_CHAINS_SCHEMA);
	let chains = new PublicationChains(db);
	cleanup.push(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		path,
		get db() {
			return db;
		},
		get chains() {
			return chains;
		},
		charge(
			key = "one",
			roots = root,
			actor = "alice",
			revision = 1,
			settings = limits,
			cooldown = true,
			worldId = "world",
		) {
			return transaction(db, () =>
				chains.charge(worldId, key, roots, actor, revision, settings, cooldown),
			);
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			chains = new PublicationChains(db);
			chains.validate();
		},
		snapshot() {
			return tables.map((table) =>
				db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			);
		},
	};
}

test("chain snapshot zero is empty, world-scoped and read-only before and after later charges", () => {
	const f = fixture();
	const empty: PublicationChainSnapshot = {
		version: 1,
		worldId: "world",
		revision: 0,
		digest: null,
		roots: [],
	};
	const before = f.snapshot();
	expect(f.chains.snapshot("world")).toEqual(empty);
	expect(f.chains.snapshot("world", 0)).toEqual(empty);
	expect(f.snapshot()).toEqual(before);
	f.charge();
	f.reopen();
	const saved = f.snapshot();
	expect(f.chains.snapshot("world", 0)).toEqual(empty);
	expect(f.chains.snapshot("other")).toEqual({ ...empty, worldId: "other" });
	expect(f.snapshot()).toEqual(saved);
});

test("chain snapshot freezes complete mixed-root counts and the receipt prefix digest across advance and real reopen", () => {
	const f = fixture();
	const roots = [
		{ rootId: "z", depth: 1 },
		{ rootId: "a", depth: 2 },
		{ rootId: "a", depth: 1 },
	];
	f.charge("one", roots, "alice", 40);
	const firstDigest = f.db
		.prepare(
			"SELECT digest FROM life_publication_chain_actions WHERE world_id='world' AND action_key='one'",
		)
		.get()?.["digest"];
	if (typeof firstDigest !== "string")
		throw Error("Missing fixture receipt digest");
	const first: PublicationChainSnapshot = {
		version: 1,
		worldId: "world",
		revision: 1,
		digest: firstDigest,
		roots: [
			{ rootId: "a", actions: 1 },
			{ rootId: "z", actions: 1 },
		],
	};
	expect(f.chains.snapshot("world")).toEqual(first);
	f.charge(
		"two",
		[
			{ rootId: "m", depth: 0 },
			{ rootId: "a", depth: 3 },
		],
		"bob",
		90,
	);
	const secondDigest = f.db
		.prepare(
			"SELECT digest FROM life_publication_chain_actions WHERE world_id='world' AND action_key='two'",
		)
		.get()?.["digest"];
	if (typeof secondDigest !== "string")
		throw Error("Missing fixture receipt digest");
	const second: PublicationChainSnapshot = {
		version: 1,
		worldId: "world",
		revision: 2,
		digest: secondDigest,
		roots: [
			{ rootId: "a", actions: 2 },
			{ rootId: "m", actions: 1 },
			{ rootId: "z", actions: 1 },
		],
	};
	expect(secondDigest).not.toBe(firstDigest);
	expect(f.chains.snapshot("world")).toEqual(second);
	f.charge("three", [{ rootId: "m", depth: 0 }], "carol", 0);
	f.reopen();
	const saved = f.snapshot();
	const db = new DatabaseSync(f.path, { readOnly: true });
	try {
		const reader = new PublicationChains(db);
		expect(reader.snapshot("world", 1)).toEqual(first);
		expect(reader.snapshot("world", 2)).toEqual(second);
		const current = reader.snapshot("world");
		expect(current.revision).toBe(3);
		expect(current.roots).toEqual([
			{ rootId: "a", actions: 2 },
			{ rootId: "m", actions: 2 },
			{ rootId: "z", actions: 1 },
		]);
		expect(reader.snapshot("world", 3)).toEqual(current);
		const detached = reader.snapshot("world", 1);
		detached.roots.splice(0);
		expect(reader.snapshot("world", 1)).toEqual(first);
	} finally {
		db.close();
	}
	expect(f.snapshot()).toEqual(saved);
});

test("chain snapshot rejects unknown worlds, future sequences and unsafe revisions without writes", () => {
	const f = fixture();
	f.charge();
	const saved = f.snapshot();
	for (const worldId of ["unknown", "x".repeat(129), ""]) {
		expect(() => f.chains.snapshot(worldId)).toThrow(
			/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
		);
		expect(() => f.chains.snapshot(worldId, 0)).toThrow(
			/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
		);
	}
	for (const at of [
		-1,
		0.5,
		Number.NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		2,
		Number.MAX_SAFE_INTEGER,
	])
		expect(() => f.chains.snapshot("world", at)).toThrow(
			/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
		);
	expect(f.snapshot()).toEqual(saved);
});

for (const [name, sql] of [
	[
		"missing latest charges",
		"DELETE FROM life_publication_chain_charges WHERE action_key='two'",
	],
	["missing state head", "DELETE FROM life_publication_chain_state"],
	[
		"regressed current head",
		"UPDATE life_publication_chain_state SET action_count=1",
	],
	[
		"forged current counter",
		"UPDATE life_publication_chain_roots SET action_count=3",
	],
	["missing root head", "DELETE FROM life_publication_chain_roots"],
	[
		"corrupt latest receipt",
		"UPDATE life_publication_chain_actions SET digest='bad' WHERE action_key='two'",
	],
	[
		"broken latest charge relation",
		"UPDATE life_publication_chain_charges SET action_key='missing' WHERE action_key='two'",
	],
	[
		"missing latest receipt",
		"DELETE FROM life_publication_chain_actions WHERE action_key='two'",
	],
] as const) {
	test(`chain snapshot audits all current history even for historical zero: ${name}`, () => {
		const f = fixture();
		f.charge();
		f.charge("two", root, "bob", 3);
		f.db.exec("PRAGMA foreign_keys=OFF");
		f.db.exec(sql);
		expect(() => f.reopen()).toThrow(
			/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
		);
		const damaged = f.snapshot();
		for (const at of [0, 1, 2, undefined])
			expect(() => f.chains.snapshot("world", at)).toThrow(
				/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
			);
		expect(f.snapshot()).toEqual(damaged);
	});
}

test("chain snapshot parser canonicalizes detached roots and accepts the empty sequence", () => {
	const empty: PublicationChainSnapshot = {
		version: 1,
		worldId: "world",
		revision: 0,
		digest: null,
		roots: [],
	};
	expect(parsePublicationChainSnapshot(empty)).toEqual(empty);
	const value: PublicationChainSnapshot = {
		version: 1,
		worldId: "w".repeat(128),
		revision: 3,
		digest: "a".repeat(64),
		roots: [
			{ rootId: "z", actions: 1 },
			{ rootId: "a", actions: 2 },
		],
	};
	const parsed = parsePublicationChainSnapshot(value);
	expect(parsed).toEqual({
		...value,
		roots: [
			{ rootId: "a", actions: 2 },
			{ rootId: "z", actions: 1 },
		],
	});
	parsed.roots.splice(0);
	expect(value.roots).toHaveLength(2);
});

test("chain snapshot parser rejects malformed shapes, impossible counts, unsafe numbers and executable values", () => {
	const value: PublicationChainSnapshot = {
		version: 1,
		worldId: "world",
		revision: 1,
		digest: "a".repeat(64),
		roots: [{ rootId: "root", actions: 1 }],
	};
	const invalid: unknown[] = [
		null,
		[],
		{},
		{ ...value, extra: true },
		{ ...value, version: 2 },
		{ ...value, worldId: "x".repeat(129) },
		{ ...value, digest: "invalid" },
		{ ...value, digest: null },
		{ ...value, roots: [] },
		{ ...value, revision: 0 },
		{ ...value, revision: 0, roots: [] },
		{ ...value, roots: [{ rootId: "root", actions: 0 }] },
		{ ...value, roots: [{ rootId: "root", actions: 2 }] },
		{ ...value, roots: [{ rootId: "root", actions: 1, extra: true }] },
		{ ...value, roots: [value.roots[0], value.roots[0]] },
		{ ...value, revision: 2 },
		{
			...value,
			roots: Array.from({ length: MAX_LIFE_ITEMS + 1 }, (_, i) => ({
				rootId: `r-${i}`,
				actions: 1,
			})),
		},
		{
			...value,
			revision: MAX_LIFE_ITEMS + 1,
			roots: [{ rootId: "root", actions: MAX_LIFE_ITEMS + 1 }],
		},
	];
	for (const number of [
		-1,
		0.5,
		Infinity,
		Number.NaN,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		invalid.push({ ...value, revision: number });
		invalid.push({ ...value, roots: [{ rootId: "root", actions: number }] });
	}
	let called = false;
	invalid.push({
		...value,
		get revision() {
			called = true;
			return 1;
		},
	});
	for (const input of invalid)
		expect(() => parsePublicationChainSnapshot(input)).toThrow(
			/^(Invalid|Unknown|Missing|Corrupt|Orphan|Future|Duplicate)/,
		);
	expect(called).toBe(false);
});

test("mixed roots with one exhausted deny all without empty roots or an action receipt", () => {
	const f = fixture();
	const one = { ...limits, maxActionsPerChain: 1 };
	expect(f.charge("first", root, "alice", 1, one)).toEqual(charged);
	const before = f.snapshot();
	const roots = [
		{ rootId: "new", depth: 1 },
		{ rootId: "root", depth: 1 },
	];
	expect(
		f.chains.canCharge("world", "second", roots, "bob", 9, one, false),
	).toBe(false);
	expect(f.charge("second", roots, "bob", 9, one, false)).toEqual(denied);
	expect(f.snapshot()).toEqual(before);
	f.reopen();
	expect(f.snapshot()).toEqual(before);
});

test("depth boundary is inclusive, duplicate roots merge maximum depth and charge once", () => {
	const f = fixture();
	const roots = [
		{ rootId: "root", depth: 1 },
		{ rootId: "root", depth: 3 },
	];
	expect(f.charge("one", roots)).toEqual(charged);
	expect(f.charge("one", [{ rootId: "root", depth: 3 }])).toEqual(replayed);
	expect(f.charge("too-deep", [{ rootId: "fresh", depth: 4 }], "bob")).toEqual(
		denied,
	);
	expect(
		f.charge(
			"merged-too-deep",
			[...roots, { rootId: "root", depth: 4 }],
			"bob",
		),
	).toEqual(denied);
	expect(f.charge("two", root, "bob")).toEqual(charged);
	expect(f.charge("three", root, "carol")).toEqual(charged);
	expect(f.charge("four", root, "dave")).toEqual(denied);
	f.reopen();
});

test("zero depth and action capacities explicitly disable even depth zero; zero cooldown permits same revision", () => {
	const f = fixture();
	for (const disabled of [
		{ ...limits, maxChainDepth: 0 },
		{ ...limits, maxActionsPerChain: 0 },
	]) {
		expect(
			f.chains.canCharge("world", "zero", root, "alice", 0, disabled, false),
		).toBe(false);
		expect(f.charge("zero", root, "alice", 0, disabled, false)).toEqual(denied);
	}
	expect(f.snapshot().every((rows) => rows.length === 0)).toBe(true);
	const zeroCooldown = { ...limits, perAuthorCooldownSteps: 0 };
	expect(f.charge("one", root, "alice", 0, zeroCooldown)).toEqual(charged);
	expect(f.charge("two", root, "alice", 0, zeroCooldown)).toEqual(charged);
	f.reopen();
});

test("canCharge is a pure read, including first admission, denial and exact historical replay", () => {
	const f = fixture();
	const before = f.snapshot();
	expect(
		f.chains.canCharge("world", "one", root, "alice", 1, limits, true),
	).toBe(true);
	expect(f.snapshot()).toEqual(before);
	f.charge();
	f.charge("later", root, "alice", 3);
	const saved = f.snapshot();
	const db = new DatabaseSync(f.path, { readOnly: true });
	try {
		const reader = new PublicationChains(db);
		expect(
			reader.canCharge("world", "one", root, "alice", 1, limits, true),
		).toBe(true);
		expect(
			reader.canCharge("world", "next", root, "alice", 4, limits, true),
		).toBe(false);
		reader.validate();
	} finally {
		db.close();
	}
	expect(f.snapshot()).toEqual(saved);
});

test("hasCharge proves existing canonical receipts after reopen, not merely available capacity, without writes", () => {
	const f = fixture();
	const settings = { ...limits, maxActionsPerChain: 1 };
	const roots = [
		{ rootId: "z", depth: 1 },
		{ rootId: "a", depth: 2 },
	];
	const original: Parameters<PublicationChains["charge"]> = [
		"world",
		"one",
		roots,
		"alice",
		1,
		settings,
		true,
	];
	const empty = f.snapshot();
	expect(f.chains.canCharge(...original)).toBe(true);
	expect(f.chains.hasCharge(...original)).toBe(false);
	expect(f.snapshot()).toEqual(empty);
	f.charge("one", roots, "alice", 1, settings);
	f.charge("later", root, "alice", 10, {
		...settings,
		perAuthorCooldownSteps: 0,
	});
	f.reopen();
	const saved = f.snapshot();
	const db = new DatabaseSync(f.path, { readOnly: true });
	try {
		const reader = new PublicationChains(db);
		expect(reader.hasCharge(...original)).toBe(true);
		expect(
			reader.hasCharge(
				"world",
				"one",
				[...roots.toReversed(), { rootId: "a", depth: 0 }],
				"alice",
				1,
				settings,
				true,
			),
		).toBe(true);
		expect(
			reader.hasCharge("other", "one", roots, "alice", 1, settings, true),
		).toBe(false);
		expect(
			reader.canCharge(
				"world",
				"missing",
				[{ rootId: "new", depth: 0 }],
				"bob",
				1,
				settings,
				true,
			),
		).toBe(true);
		expect(
			reader.hasCharge(
				"world",
				"missing",
				[{ rootId: "new", depth: 0 }],
				"bob",
				1,
				settings,
				true,
			),
		).toBe(false);
		expect(
			reader.canCharge("world", "exhausted", roots, "bob", 1, settings, true),
		).toBe(false);
		expect(
			reader.hasCharge("world", "exhausted", roots, "bob", 1, settings, true),
		).toBe(false);
	} finally {
		db.close();
	}
	expect(f.snapshot()).toEqual(saved);
});

test("hasCharge conflicts on any changed payload under an existing key without writes", () => {
	const f = fixture();
	f.charge();
	const saved = f.snapshot();
	const conflicts: Parameters<PublicationChains["charge"]>[] = [
		["world", "one", root, "bob", 1, limits, true],
		["world", "one", [{ rootId: "root", depth: 1 }], "alice", 1, limits, true],
		["world", "one", root, "alice", 2, limits, true],
		[
			"world",
			"one",
			root,
			"alice",
			1,
			{ ...limits, maxActionsPerChain: 0 },
			true,
		],
		["world", "one", root, "alice", 1, limits, false],
	];
	f.db.exec("PRAGMA query_only=ON");
	for (const args of conflicts)
		expect(() => f.chains.hasCharge(...args)).toThrow(/conflict/i);
	expect(f.snapshot()).toEqual(saved);
});

test("hasCharge audits an existing receipt instead of accepting a key with missing root charges", () => {
	const f = fixture();
	f.charge();
	f.db.exec("DELETE FROM life_publication_chain_charges");
	const damaged = f.snapshot();
	const db = new DatabaseSync(f.path, { readOnly: true });
	try {
		expect(() =>
			new PublicationChains(db).hasCharge(
				"world",
				"one",
				root,
				"alice",
				1,
				limits,
				true,
			),
		).toThrow(/Missing publication chain charges/);
	} finally {
		db.close();
	}
	expect(f.snapshot()).toEqual(damaged);
});

test("accepted LIFE revisions own cooldown across roots, worlds and file reopen; user actions still spend every root", () => {
	const f = fixture();
	const settings = {
		...limits,
		maxActionsPerChain: 10,
		perAuthorCooldownSteps: 3,
	};
	const roots = [
		{ rootId: "first", depth: 1 },
		{ rootId: "second", depth: 1 },
	];
	expect(f.charge("one", roots, "alice", 10, settings)).toEqual(charged);
	expect(f.charge("user", roots, "alice", 12, settings, false)).toEqual(
		charged,
	);
	f.reopen();
	expect(f.charge("regressed", root, "alice", 11, settings, false)).toEqual(
		denied,
	);
	expect(f.charge("early", root, "alice", 12, settings)).toEqual(denied);
	expect(f.charge("boundary", root, "alice", 13, settings)).toEqual(charged);
	expect(f.charge("other-actor", root, "bob", 0, settings)).toEqual(charged);
	expect(f.charge("one", roots, "alice", 0, settings, true, "other")).toEqual(
		charged,
	);
	for (const row of f.db
		.prepare(
			"SELECT action_count FROM life_publication_chain_roots WHERE world_id='world' AND root_id IN ('first','second')",
		)
		.all())
		expect(row["action_count"]).toBe(2);
	f.reopen();
});

test("cooldown false neither establishes nor advances cooldown, and safe revision subtraction cannot overflow", () => {
	const f = fixture();
	const settings = {
		...limits,
		maxActionsPerChain: 10,
		perAuthorCooldownSteps: Number.MAX_SAFE_INTEGER,
	};
	expect(f.charge("user", root, "alice", 1, settings, false)).toEqual(charged);
	expect(f.charge("auto", root, "alice", 1, settings)).toEqual(charged);
	expect(
		f.charge("far", root, "alice", Number.MAX_SAFE_INTEGER, settings),
	).toEqual(denied);
	expect(
		f.charge(
			"user-far",
			root,
			"alice",
			Number.MAX_SAFE_INTEGER,
			settings,
			false,
		),
	).toEqual(charged);
	expect(
		f.charge("zero", root, "alice", Number.MAX_SAFE_INTEGER, {
			...settings,
			perAuthorCooldownSteps: 0,
		}),
	).toEqual(charged);
	f.reopen();
});

test("exact canonical key payload replays, changed limits conflict, and later settings do not rewrite history", () => {
	const f = fixture();
	const roots = [
		{ rootId: "z", depth: 1 },
		{ rootId: "a", depth: 2 },
	];
	f.charge("one", roots);
	f.charge("two", root, "alice", 5, { ...limits, perAuthorCooldownSteps: 0 });
	f.reopen();
	expect(f.charge("one", roots.toReversed())).toEqual(replayed);
	const conflicts: Parameters<PublicationChains["charge"]>[] = [
		["world", "one", roots, "bob", 1, limits, true],
		["world", "one", root, "alice", 1, limits, true],
		["world", "one", roots, "alice", 2, limits, true],
		["world", "one", roots, "alice", 1, limits, false],
		[
			"world",
			"one",
			roots,
			"alice",
			1,
			{ ...limits, maxActionsPerChain: 0 },
			true,
		],
	];
	for (const args of conflicts) {
		expect(() => f.chains.canCharge(...args)).toThrow(/conflict/i);
		expect(() => transaction(f.db, () => f.chains.charge(...args))).toThrow(
			/conflict/i,
		);
	}
	f.reopen();
});

test("caller transaction owns rollback including unrelated work, and charge requires a transaction", () => {
	const f = fixture();
	expect(() =>
		f.chains.charge("world", "one", root, "alice", 1, limits, true),
	).toThrow(/transaction/i);
	expect(() =>
		transaction(f.db, () => {
			f.db.exec("INSERT INTO worlds VALUES('rollback-marker')");
			expect(
				f.chains.charge("world", "one", root, "alice", 1, limits, true),
			).toEqual(charged);
			throw Error("caller failure");
		}),
	).toThrow("caller failure");
	expect(
		f.db.prepare("SELECT id FROM worlds WHERE id='rollback-marker'").get(),
	).toBeUndefined();
	expect(f.snapshot().every((rows) => rows.length === 0)).toBe(true);
	f.db.exec(
		"CREATE TRIGGER fail_second_root BEFORE INSERT ON life_publication_chain_charges WHEN NEW.root_id='z' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
	);
	expect(() =>
		f.charge("fail", [
			{ rootId: "a", depth: 0 },
			{ rootId: "z", depth: 0 },
		]),
	).toThrow("injected storage failure");
	expect(f.snapshot().every((rows) => rows.length === 0)).toBe(true);
	f.reopen();
});

test("two connections serialize the final allowance and cannot observe partial all-root charges", () => {
	const f = fixture();
	const db = new DatabaseSync(f.path);
	db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
	const second = new PublicationChains(db);
	const settings = { ...limits, maxActionsPerChain: 1 };
	const roots = [
		{ rootId: "a", depth: 0 },
		{ rootId: "b", depth: 0 },
	];
	try {
		expect(
			second.canCharge("world", "second", roots, "bob", 1, settings, false),
		).toBe(true);
		f.db.exec("BEGIN IMMEDIATE");
		expect(
			f.chains.charge("world", "first", roots, "alice", 1, settings, false),
		).toEqual(charged);
		expect(
			db
				.prepare("SELECT count(*) AS n FROM life_publication_chain_charges")
				.get()?.["n"],
		).toBe(0);
		expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
		f.db.exec("COMMIT");
		expect(
			transaction(db, () =>
				second.charge("world", "second", roots, "bob", 1, settings, false),
			),
		).toEqual(denied);
		expect(
			transaction(db, () =>
				second.charge("world", "first", roots, "alice", 1, settings, false),
			),
		).toEqual(replayed);
		expect(
			db
				.prepare("SELECT count(*) AS n FROM life_publication_chain_charges")
				.get()?.["n"],
		).toBe(2);
	} finally {
		if (f.db.isTransaction) f.db.exec("ROLLBACK");
		db.close();
	}
	f.reopen();
});

test("strict input bounds reject unsafe numbers, unknown shapes, invalid owners and empty roots without writes", () => {
	const f = fixture();
	const base: Parameters<PublicationChains["charge"]> = [
		"world",
		"one",
		root,
		"alice",
		1,
		limits,
		true,
	];
	const invalid: unknown[][] = [
		["world", "one", [], "alice", 1, limits, true],
		["missing", ...base.slice(1)],
		["world", "x".repeat(129), ...base.slice(2)],
		["world", "one", [{ rootId: "x".repeat(129), depth: 0 }], ...base.slice(3)],
		[
			"world",
			"one",
			Array.from({ length: MAX_LIFE_ITEMS + 1 }, () => root[0]),
			...base.slice(3),
		],
		[
			"world",
			"one",
			[{ rootId: "root", depth: 1, unknown: true }],
			...base.slice(3),
		],
		[...base.slice(0, 3), "x".repeat(129), ...base.slice(4)],
		[...base.slice(0, 5), { ...limits, unknown: true }, true],
		[...base.slice(0, 6), "true"],
	];
	for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		invalid.push([...base.slice(0, 4), n, limits, true]);
		for (const key of Object.keys(limits))
			invalid.push([...base.slice(0, 5), { ...limits, [key]: n }, true]);
		invalid.push([
			"world",
			"one",
			[{ rootId: "root", depth: n }],
			...base.slice(3),
		]);
	}
	for (const key of ["maxChainDepth", "maxActionsPerChain"])
		invalid.push([
			...base.slice(0, 5),
			{ ...limits, [key]: MAX_LIFE_ITEMS + 1 },
			true,
		]);
	for (const args of invalid) {
		// Deliberately crosses the runtime boundary with invalid persisted/input values.
		const call = args as Parameters<PublicationChains["charge"]>;
		expect(() => f.chains.canCharge(...call)).toThrow();
		expect(() => transaction(f.db, () => f.chains.charge(...call))).toThrow();
	}
	expect(f.snapshot().every((rows) => rows.length === 0)).toBe(true);
	f.reopen();
});

test("world root capacity denies a new root atomically but preserves existing charges, replay and historical snapshots", () => {
	const f = fixture();
	const roots = Array.from({ length: MAX_LIFE_ITEMS }, (_, i) => ({
		rootId: `root-${String(i).padStart(4, "0")}`,
		depth: 0,
	}));
	const settings = { ...limits, perAuthorCooldownSteps: 0 };
	expect(f.charge("bulk", roots, "alice", 1, settings)).toEqual(charged);
	const first = f.chains.snapshot("world");
	expect(first.revision).toBe(1);
	expect(first.roots).toEqual(
		roots.map(({ rootId }) => ({ rootId, actions: 1 })),
	);
	f.reopen();
	const saved = f.snapshot();
	const existing = [{ rootId: "root-0000", depth: 1 }];
	const overflow = [...existing, { rootId: "overflow", depth: 0 }];
	expect(
		f.chains.canCharge(
			"world",
			"overflow",
			overflow,
			"bob",
			1,
			settings,
			false,
		),
	).toBe(false);
	expect(f.charge("overflow", overflow, "bob", 1, settings, false)).toEqual(
		denied,
	);
	expect(f.snapshot()).toEqual(saved);
	expect(
		f.chains.canCharge("world", "bulk", roots, "alice", 1, settings, true),
	).toBe(true);
	expect(f.charge("bulk", roots, "alice", 1, settings)).toEqual(replayed);
	expect(
		f.chains.hasCharge("world", "bulk", roots, "alice", 1, settings, true),
	).toBe(true);
	expect(f.snapshot()).toEqual(saved);
	expect(
		f.chains.canCharge(
			"world",
			"existing",
			existing,
			"alice",
			1,
			settings,
			true,
		),
	).toBe(true);
	expect(f.charge("existing", existing, "alice", 1, settings)).toEqual(charged);
	f.reopen();
	expect(f.chains.snapshot("world", 1)).toEqual(first);
	expect(f.chains.snapshot("world", 0)).toEqual({
		version: 1,
		worldId: "world",
		revision: 0,
		digest: null,
		roots: [],
	});
	const current = f.chains.snapshot("world");
	expect(current.revision).toBe(2);
	expect(current.roots).toEqual(
		roots.map(({ rootId }) => ({
			rootId,
			actions: rootId === "root-0000" ? 2 : 1,
		})),
	);
	expect(parsePublicationChainSnapshot(current)).toEqual(current);
	expect(
		f.chains.canCharge(
			"other",
			"independent",
			[{ rootId: "overflow", depth: 0 }],
			"alice",
			1,
			settings,
			true,
		),
	).toBe(true);
});

test("world root capacity checks every new distinct root before crossing the final slot", () => {
	const f = fixture();
	const roots = Array.from({ length: MAX_LIFE_ITEMS - 1 }, (_, i) => ({
		rootId: `root-${i}`,
		depth: 0,
	}));
	f.charge("bulk", roots);
	const saved = f.snapshot();
	const tooMany = [
		{ rootId: "root-0", depth: 1 },
		{ rootId: "new-a", depth: 0 },
		{ rootId: "new-b", depth: 0 },
	];
	expect(
		f.chains.canCharge("world", "overflow", tooMany, "bob", 1, limits, false),
	).toBe(false);
	expect(f.charge("overflow", tooMany, "bob", 1, limits, false)).toEqual(
		denied,
	);
	expect(f.snapshot()).toEqual(saved);
	const finalRoot = [
		{ rootId: "new-a", depth: 0 },
		{ rootId: "new-a", depth: 1 },
		{ rootId: "root-0", depth: 1 },
	];
	expect(f.charge("last-slot", finalRoot, "bob", 1, limits, false)).toEqual(
		charged,
	);
	f.reopen();
	const current = f.chains.snapshot("world");
	expect(current.roots).toHaveLength(MAX_LIFE_ITEMS);
	expect(current.roots.find((r) => r.rootId === "new-a")).toEqual({
		rootId: "new-a",
		actions: 1,
	});
	expect(current.roots.find((r) => r.rootId === "root-0")).toEqual({
		rootId: "root-0",
		actions: 2,
	});
});

test("world root capacity rejects otherwise consistent oversized history on real reopen and historical zero reads", () => {
	const f = fixture();
	const roots = Array.from({ length: MAX_LIFE_ITEMS }, (_, i) => ({
		rootId: `root-${i}`,
		depth: 0,
	}));
	f.charge("bulk", roots);
	const previousDigest = f.db
		.prepare(
			"SELECT digest FROM life_publication_chain_state WHERE world_id='world'",
		)
		.get()?.["digest"];
	if (typeof previousDigest !== "string")
		throw Error("Missing fixture receipt digest");
	// Construct the previously admissible 4097-root state with all receipt/hash/FK links intact.
	const action = {
		version: 1,
		worldId: "world",
		key: "overflow",
		roots: [{ rootId: "overflow", depth: 0 }],
		actorId: "bob",
		lifeRevision: 1,
		limits,
		cooldown: false,
		sequence: 2,
		previousDigest,
	};
	const hash = lifeDigest(action);
	transaction(f.db, () => {
		f.db
			.prepare(
				"INSERT INTO life_publication_chain_actions(world_id,action_key,sequence,record_json,digest) VALUES(?,?,?,?,?)",
			)
			.run("world", "overflow", 2, canonicalLifeJson(action), hash);
		f.db
			.prepare(
				"INSERT INTO life_publication_chain_roots(world_id,root_id,action_count) VALUES(?,?,?)",
			)
			.run("world", "overflow", 1);
		f.db
			.prepare(
				"INSERT INTO life_publication_chain_charges(world_id,root_id,sequence,action_key,action_digest) VALUES(?,?,?,?,?)",
			)
			.run("world", "overflow", 1, "overflow", hash);
		f.db
			.prepare(
				"UPDATE life_publication_chain_state SET action_count=2,digest=? WHERE world_id='world'",
			)
			.run(hash);
	});
	expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	const damaged = f.snapshot();
	expect(() => f.reopen()).toThrow("Corrupt publication chain action history");
	expect(() => f.chains.snapshot("world", 0)).toThrow(
		"Corrupt publication chain action history",
	);
	expect(() => f.chains.snapshot("world", 1)).toThrow(
		"Corrupt publication chain action history",
	);
	expect(() => f.chains.snapshot("world")).toThrow(
		"Corrupt publication chain action history",
	);
	expect(f.snapshot()).toEqual(damaged);
});

test("maximum technical roots and ID length are accepted without mutating caller input", () => {
	const f = fixture();
	const roots: PublicationChainRef[] = Array.from(
		{ length: MAX_LIFE_ITEMS },
		(_, n) => ({ rootId: `root-${n}`, depth: MAX_LIFE_ITEMS }),
	);
	const original = structuredClone(roots);
	expect(
		f.charge("k".repeat(128), roots, "a".repeat(128), 0, {
			...limits,
			maxChainDepth: MAX_LIFE_ITEMS,
		}),
	).toEqual(charged);
	expect(roots).toEqual(original);
	f.reopen();
});

for (const [name, sql] of [
	[
		"deleted counter",
		"DELETE FROM life_publication_chain_roots WHERE root_id='root'",
	],
	[
		"regressed counter",
		"UPDATE life_publication_chain_roots SET action_count=1",
	],
	["forged counter", "UPDATE life_publication_chain_roots SET action_count=3"],
	[
		"missing action",
		"DELETE FROM life_publication_chain_actions WHERE action_key='one'",
	],
	[
		"missing root charge",
		"DELETE FROM life_publication_chain_charges WHERE sequence=1",
	],
	[
		"noncontiguous charge",
		"UPDATE life_publication_chain_charges SET sequence=3 WHERE sequence=2",
	],
	[
		"changed receipt digest",
		"UPDATE life_publication_chain_actions SET digest='bad' WHERE action_key='one'",
	],
	[
		"wrong charge owner",
		"UPDATE life_publication_chain_charges SET world_id='other' WHERE sequence=1",
	],
	[
		"wrong head owner",
		"UPDATE life_publication_chain_state SET world_id='other'",
	],
	["deleted state", "DELETE FROM life_publication_chain_state"],
	[
		"missing all history",
		"DELETE FROM life_publication_chain_charges; DELETE FROM life_publication_chain_actions",
	],
	[
		"history and root heads deleted",
		"DELETE FROM life_publication_chain_charges; DELETE FROM life_publication_chain_actions; DELETE FROM life_publication_chain_roots",
	],
	["unknown world", "DELETE FROM worlds WHERE id='world'"],
	[
		"unsafe count",
		"UPDATE life_publication_chain_roots SET action_count=9007199254740992",
	],
	[
		"unsafe sequence",
		"UPDATE life_publication_chain_actions SET sequence=9007199254740992 WHERE action_key='two'",
	],
	[
		"invalid JSON",
		"UPDATE life_publication_chain_actions SET record_json='{' WHERE action_key='one'",
	],
] as const) {
	test(`actual reopen rejects ${name}`, () => {
		const f = fixture();
		f.charge();
		f.charge("two", root, "alice", 3);
		f.db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
		f.db.exec(sql);
		expect(() => f.reopen()).toThrow();
	});
}

/** Rehash every redundant hash to reach semantic audit checks, not merely digest mismatch. */
function rewriteHistory(
	db: DatabaseSync,
	mutate: (record: Record<string, unknown>) => void,
) {
	let previousDigest: string | null = null;
	for (const row of db
		.prepare(
			"SELECT action_key,record_json FROM life_publication_chain_actions ORDER BY sequence",
		)
		.all()) {
		const record = JSON.parse(String(row["record_json"])) as Record<
			string,
			unknown
		>;
		mutate(record);
		record["previousDigest"] = previousDigest;
		const digest = lifeDigest(record);
		db.prepare(
			"UPDATE life_publication_chain_actions SET record_json=?,digest=? WHERE action_key=?",
		).run(canonicalLifeJson(record), digest, row["action_key"] ?? null);
		db.prepare(
			"UPDATE life_publication_chain_charges SET action_digest=? WHERE action_key=?",
		).run(digest, row["action_key"] ?? null);
		previousDigest = digest;
	}
	db.prepare("UPDATE life_publication_chain_state SET digest=?").run(
		previousDigest,
	);
}
for (const [name, mutate] of [
	[
		"unknown field",
		(r) => {
			r["extra"] = true;
		},
	],
	[
		"wrong world",
		(r) => {
			r["worldId"] = "other";
		},
	],
	[
		"wrong key",
		(r) => {
			r["key"] = "changed";
		},
	],
	[
		"unknown version",
		(r) => {
			r["version"] = 2;
		},
	],
	[
		"fractional revision",
		(r) => {
			r["lifeRevision"] = 0.5;
		},
	],
	[
		"decreasing actor revision",
		(r) => {
			r["lifeRevision"] = r["key"] === "one" ? 4 : 3;
		},
	],
	[
		"cooldown violation",
		(r) => {
			r["lifeRevision"] = 1;
		},
	],
	[
		"exceeded frozen capacity",
		(r) => {
			r["limits"] = { ...limits, maxActionsPerChain: 1 };
		},
	],
	[
		"exceeded frozen depth",
		(r) => {
			r["roots"] = [{ rootId: "root", depth: 4 }];
		},
	],
	[
		"duplicate persisted roots",
		(r) => {
			r["roots"] = [...root, ...root];
		},
	],
	[
		"changed root set",
		(r) => {
			r["roots"] = [{ rootId: "different", depth: 0 }];
		},
	],
	[
		"empty roots",
		(r) => {
			r["roots"] = [];
		},
	],
] satisfies Array<[string, (r: Record<string, unknown>) => void]>) {
	test(`actual reopen rejects fully rehashed ${name}`, () => {
		const f = fixture();
		f.charge();
		f.charge("two", root, "alice", 3);
		rewriteHistory(f.db, mutate);
		expect(() => f.reopen()).toThrow();
	});
}
