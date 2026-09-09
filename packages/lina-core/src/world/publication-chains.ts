import type { DatabaseSync } from "node:sqlite";
import {
	array,
	canonicalLifeJson,
	digest,
	flag,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import type { PublicationSettingsInput } from "./publication-types.ts";
import { fields, integer } from "./validation.ts";

export interface PublicationChainRef {
	rootId: string;
	depth: number;
}
export interface PublicationChainSnapshot {
	version: 1;
	worldId: string;
	revision: number;
	digest: string | null;
	roots: Array<{ rootId: string; actions: number }>;
}

/** Strict bounded JSON codec; compare with snapshot() to verify the receipt prefix. */
export function parsePublicationChainSnapshot(
	value: unknown,
): PublicationChainSnapshot {
	jsonBoundary(value);
	fields(value, ["version", "worldId", "revision", "digest", "roots"]);
	if (value.version !== 1)
		throw Error("Invalid publication chain snapshot version");
	const at = revision(value.revision);
	const snapshot: PublicationChainSnapshot = {
		version: 1,
		worldId: identifier(value.worldId),
		revision: at,
		digest: value.digest === null ? null : digest(value.digest),
		roots: keyed(
			array(value.roots, (root) => {
				fields(root, ["rootId", "actions"]);
				integer(
					root.actions,
					"publication chain snapshot count",
					1,
					Math.min(at, MAX_LIFE_ITEMS),
				);
				return { rootId: identifier(root.rootId), actions: root.actions };
			}),
			(root) => root.rootId,
		),
	};
	if (
		at === 0
			? snapshot.digest !== null || snapshot.roots.length !== 0
			: snapshot.digest === null ||
				snapshot.roots.reduce((sum, root) => sum + root.actions, 0) < at
	)
		throw Error("Invalid publication chain snapshot prefix");
	return snapshot;
}

type ChainLimits = Pick<
	PublicationSettingsInput,
	"maxChainDepth" | "maxActionsPerChain" | "perAuthorCooldownSteps"
>;
interface ChainRequest {
	worldId: string;
	key: string;
	roots: PublicationChainRef[];
	actorId: string;
	lifeRevision: number;
	limits: ChainLimits;
	cooldown: boolean;
}
interface ChainAction extends ChainRequest {
	version: 1;
	sequence: number;
	previousDigest: string | null;
}
interface ChainHistory {
	count: number;
	digest: string | null;
	roots: Map<string, number>;
	actors: Map<string, { last: number; cooldown: number | null }>;
	replay: ChainAction | null;
	snapshot: PublicationChainSnapshot | null;
}

/** Registered by schema 7; no settings, roots or activity are invented by DDL. */
export const PUBLICATION_CHAINS_SCHEMA: string = `
CREATE TABLE life_publication_chain_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 action_count INTEGER NOT NULL CHECK(action_count BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
 digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_publication_chain_actions (
 world_id TEXT NOT NULL REFERENCES worlds(id), action_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,action_key), UNIQUE(world_id,sequence)
) STRICT;
CREATE TABLE life_publication_chain_roots (
 world_id TEXT NOT NULL REFERENCES worlds(id), root_id TEXT NOT NULL,
 action_count INTEGER NOT NULL CHECK(action_count BETWEEN 1 AND ${MAX_LIFE_ITEMS}),
 PRIMARY KEY(world_id,root_id)
) STRICT;
CREATE TABLE life_publication_chain_charges (
 world_id TEXT NOT NULL REFERENCES worlds(id), root_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND ${MAX_LIFE_ITEMS}),
 action_key TEXT NOT NULL, action_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,root_id,sequence), UNIQUE(world_id,action_key,root_id),
 FOREIGN KEY(world_id,root_id) REFERENCES life_publication_chain_roots(world_id,root_id),
 FOREIGN KEY(world_id,action_key) REFERENCES life_publication_chain_actions(world_id,action_key)
) STRICT;
`;

function capacity(value: unknown): number {
	integer(value, "publication chain capacity", 0, MAX_LIFE_ITEMS);
	return value;
}
function request(
	worldId: unknown,
	key: unknown,
	roots: unknown,
	actorId: unknown,
	lifeRevision: unknown,
	limits: unknown,
	cooldown: unknown,
): ChainRequest {
	jsonBoundary({
		worldId,
		key,
		roots,
		actorId,
		lifeRevision,
		limits,
		cooldown,
	});
	fields(limits, [
		"maxChainDepth",
		"maxActionsPerChain",
		"perAuthorCooldownSteps",
	]);
	const merged = new Map<string, number>();
	for (const root of array(roots, (value) => {
		fields(value, ["rootId", "depth"]);
		return { rootId: identifier(value.rootId), depth: capacity(value.depth) };
	}))
		merged.set(root.rootId, Math.max(root.depth, merged.get(root.rootId) ?? 0));
	if (!merged.size) throw Error("Empty publication chain roots");
	return {
		worldId: identifier(worldId),
		key: identifier(key),
		actorId: identifier(actorId),
		lifeRevision: revision(lifeRevision),
		cooldown: flag(cooldown),
		roots: [...merged.keys()]
			.sort()
			.map((rootId) => ({ rootId, depth: merged.get(rootId) ?? 0 })),
		limits: {
			maxChainDepth: capacity(limits.maxChainDepth),
			maxActionsPerChain: capacity(limits.maxActionsPerChain),
			perAuthorCooldownSteps: revision(limits.perAuthorCooldownSteps),
		},
	};
}
function decode(row: Record<string, unknown>): ChainAction {
	if (typeof row["record_json"] !== "string")
		throw Error("Invalid publication chain JSON");
	const value: unknown = JSON.parse(row["record_json"]);
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"key",
		"roots",
		"actorId",
		"lifeRevision",
		"limits",
		"cooldown",
		"sequence",
		"previousDigest",
	]);
	if (value.version !== 1) throw Error("Unsupported publication chain version");
	const action: ChainAction = {
		...request(
			value.worldId,
			value.key,
			value.roots,
			value.actorId,
			value.lifeRevision,
			value.limits,
			value.cooldown,
		),
		version: 1,
		sequence: revision(value.sequence, 1),
		previousDigest:
			value.previousDigest === null ? null : digest(value.previousDigest),
	};
	if (
		action.worldId !== row["world_id"] ||
		action.key !== row["action_key"] ||
		action.sequence !== row["sequence"] ||
		canonicalLifeJson(action) !== row["record_json"] ||
		lifeDigest(action) !== digest(row["digest"])
	)
		throw Error("Corrupt publication chain action receipt");
	return action;
}
function allowed(action: ChainRequest, history: ChainHistory): boolean {
	const { maxChainDepth, maxActionsPerChain, perAuthorCooldownSteps } =
		action.limits;
	// Every accepted history must remain representable by the snapshot codec.
	const newRoots = action.roots.filter(
		(root) => !history.roots.has(root.rootId),
	).length;
	if (
		!maxChainDepth ||
		!maxActionsPerChain ||
		history.roots.size + newRoots > MAX_LIFE_ITEMS ||
		history.count === Number.MAX_SAFE_INTEGER ||
		action.roots.some(
			(root) =>
				root.depth > maxChainDepth ||
				(history.roots.get(root.rootId) ?? 0) >= maxActionsPerChain,
		)
	)
		return false;
	const actor = history.actors.get(action.actorId);
	if (actor && action.lifeRevision < actor.last) return false;
	return (
		!action.cooldown ||
		actor?.cooldown == null ||
		action.lifeRevision - actor.cooldown >= perAuthorCooldownSteps
	);
}
function rememberActor(action: ChainRequest, history: ChainHistory): void {
	history.actors.set(action.actorId, {
		last: action.lifeRevision,
		cooldown: action.cooldown
			? action.lifeRevision
			: (history.actors.get(action.actorId)?.cooldown ?? null),
	});
}

function snapshotFromHistory(
	worldId: string,
	history: ChainHistory,
): PublicationChainSnapshot {
	return parsePublicationChainSnapshot({
		version: 1,
		worldId,
		revision: history.count,
		digest: history.digest,
		roots: Array.from(history.roots, ([rootId, actions]) => ({
			rootId,
			actions,
		})),
	});
}

/**
 * Quantitative accounting only: the caller proves root ancestry and actor authority.
 * Caller owns BEGIN IMMEDIATE / COMMIT / ROLLBACK, including rollback on any error.
 * Retry payload includes the ORIGINAL limits, cooldown and revision; changed settings
 * under the same key conflict. Histories retain their original settings indefinitely.
 * Hashes detect inconsistent storage, not a privileged rewrite of every related row.
 */
export class PublicationChains {
	constructor(private readonly db: DatabaseSync) {}

	/** Complete counts at a world chain sequence; even historical zero audits current history. */
	snapshot(worldId: string, atRevision?: number): PublicationChainSnapshot {
		identifier(worldId);
		if (atRevision !== undefined) revision(atRevision);
		const history = this.history(worldId, undefined, atRevision);
		if (atRevision !== undefined && atRevision > history.count)
			throw Error("Future publication chain snapshot revision");
		return history.snapshot ?? snapshotFromHistory(worldId, history);
	}

	/** Read-only proof of an existing, exact, valid receipt; unused capacity is insufficient. */
	hasCharge(
		worldId: string,
		key: string,
		roots: PublicationChainRef[],
		actorId: string,
		lifeRevision: number,
		limits: ChainLimits,
		cooldown: boolean,
	): boolean {
		return (
			this.admission(
				request(worldId, key, roots, actorId, lifeRevision, limits, cooldown),
			).history.replay !== null
		);
	}

	canCharge(
		worldId: string,
		key: string,
		roots: PublicationChainRef[],
		actorId: string,
		lifeRevision: number,
		limits: ChainLimits,
		cooldown: boolean,
	): boolean {
		return this.admission(
			request(worldId, key, roots, actorId, lifeRevision, limits, cooldown),
		).allowed;
	}

	charge(
		worldId: string,
		key: string,
		roots: PublicationChainRef[],
		actorId: string,
		lifeRevision: number,
		limits: ChainLimits,
		cooldown: boolean,
	): { charged: boolean; replayed: boolean } {
		if (!this.db.isTransaction)
			throw Error("Publication chain charge requires caller transaction");
		const input = request(
			worldId,
			key,
			roots,
			actorId,
			lifeRevision,
			limits,
			cooldown,
		);
		const admission = this.admission(input);
		if (!admission.allowed) return { charged: false, replayed: false };
		if (admission.history.replay) return { charged: true, replayed: true };
		this.save(input, admission.history);
		return { charged: true, replayed: false };
	}

	validate(): void {
		for (const row of this.db
			.prepare(`
			SELECT world_id FROM life_publication_chain_state
			UNION SELECT world_id FROM life_publication_chain_actions
			UNION SELECT world_id FROM life_publication_chain_roots
			UNION SELECT world_id FROM life_publication_chain_charges
		`)
			.iterate())
			this.history(identifier(row["world_id"]));
	}

	private admission(input: ChainRequest): {
		allowed: boolean;
		history: ChainHistory;
	} {
		const history = this.history(input.worldId, input.key);
		if (history.replay) {
			const {
				version: _version,
				sequence: _sequence,
				previousDigest: _previous,
				...prior
			} = history.replay;
			if (lifeDigest(prior) !== lifeDigest(input))
				throw Error("Publication chain key payload conflict");
			return { allowed: true, history };
		}
		return { allowed: allowed(input, history), history };
	}

	private history(
		worldId: string,
		key?: string,
		atRevision?: number,
	): ChainHistory {
		if (!this.db.prepare("SELECT id FROM worlds WHERE id=?").get(worldId))
			throw Error("Unknown publication chain world");
		const history: ChainHistory = {
			count: 0,
			digest: null,
			roots: new Map(),
			actors: new Map(),
			replay: null,
			snapshot: null,
		};
		if (atRevision === 0)
			history.snapshot = snapshotFromHistory(worldId, history);
		let chargeCount = 0;
		for (const row of this.db
			.prepare(
				"SELECT world_id,action_key,sequence,record_json,digest FROM life_publication_chain_actions WHERE world_id=? ORDER BY sequence",
			)
			.iterate(worldId)) {
			const action = decode(row);
			if (
				action.worldId !== worldId ||
				action.sequence !== history.count + 1 ||
				action.previousDigest !== history.digest ||
				!allowed(action, history)
			)
				throw Error("Corrupt publication chain action history");
			chargeCount = revision(chargeCount + this.readCharges(action, history));
			rememberActor(action, history);
			history.count = action.sequence;
			history.digest = digest(row["digest"]);
			if (action.key === key) history.replay = action;
			if (history.count === atRevision)
				history.snapshot = snapshotFromHistory(worldId, history);
		}
		this.checkHeads(worldId, history, chargeCount);
		return history;
	}

	/** Rebuild root aggregates from the append-only charges, checking every receipt link. */
	private readCharges(action: ChainAction, history: ChainHistory): number {
		const rows = this.db
			.prepare(
				`SELECT root_id,sequence,action_digest FROM life_publication_chain_charges WHERE world_id=? AND action_key=? ORDER BY root_id LIMIT ${MAX_LIFE_ITEMS + 1}`,
			)
			.all(action.worldId, action.key);
		if (rows.length !== action.roots.length)
			throw Error("Missing publication chain charges");
		const expectedDigest = lifeDigest(action);
		for (const [index, row] of rows.entries()) {
			const root = action.roots[index];
			if (
				!root ||
				identifier(row["root_id"]) !== root.rootId ||
				revision(row["sequence"], 1) !==
					(history.roots.get(root.rootId) ?? 0) + 1 ||
				digest(row["action_digest"]) !== expectedDigest
			)
				throw Error("Corrupt publication chain root charge");
			history.roots.set(root.rootId, revision(row["sequence"], 1));
		}
		return rows.length;
	}

	private checkHeads(
		worldId: string,
		history: ChainHistory,
		chargeCount: number,
	): void {
		const actual = this.db
			.prepare(
				"SELECT count(*) AS n FROM life_publication_chain_charges WHERE world_id=?",
			)
			.get(worldId);
		if (revision(actual?.["n"]) !== chargeCount)
			throw Error("Orphan publication chain charge");
		let roots = 0;
		for (const row of this.db
			.prepare(
				"SELECT root_id,action_count FROM life_publication_chain_roots WHERE world_id=?",
			)
			.iterate(worldId)) {
			if (
				revision(row["action_count"], 1) !==
				history.roots.get(identifier(row["root_id"]))
			)
				throw Error("Corrupt publication chain root counter");
			roots++;
		}
		if (roots !== history.roots.size)
			throw Error("Missing publication chain root counter");
		const head = this.db
			.prepare(
				"SELECT action_count,digest FROM life_publication_chain_state WHERE world_id=?",
			)
			.get(worldId);
		if (history.count === 0 && !head) return;
		if (
			!head ||
			revision(head["action_count"], 1) !== history.count ||
			digest(head["digest"]) !== history.digest
		)
			throw Error("Missing or regressed publication chain state history");
	}

	private save(input: ChainRequest, history: ChainHistory): void {
		const action: ChainAction = {
			...input,
			version: 1,
			sequence: revision(history.count + 1, 1),
			previousDigest: history.digest,
		};
		const hash = lifeDigest(action);
		this.db
			.prepare(
				"INSERT INTO life_publication_chain_actions(world_id,action_key,sequence,record_json,digest) VALUES(?,?,?,?,?)",
			)
			.run(
				input.worldId,
				input.key,
				action.sequence,
				canonicalLifeJson(action),
				hash,
			);
		for (const root of input.roots) {
			const sequence = revision((history.roots.get(root.rootId) ?? 0) + 1, 1);
			this.db
				.prepare(
					"INSERT INTO life_publication_chain_roots(world_id,root_id,action_count) VALUES(?,?,?) ON CONFLICT(world_id,root_id) DO UPDATE SET action_count=excluded.action_count",
				)
				.run(input.worldId, root.rootId, sequence);
			this.db
				.prepare(
					"INSERT INTO life_publication_chain_charges(world_id,root_id,sequence,action_key,action_digest) VALUES(?,?,?,?,?)",
				)
				.run(input.worldId, root.rootId, sequence, input.key, hash);
		}
		this.db
			.prepare(
				"INSERT INTO life_publication_chain_state(world_id,action_count,digest) VALUES(?,?,?) ON CONFLICT(world_id) DO UPDATE SET action_count=excluded.action_count,digest=excluded.digest",
			)
			.run(input.worldId, action.sequence, hash);
	}
}
