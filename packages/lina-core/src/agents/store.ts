import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentChange,
	AgentInput,
	AgentProfile,
	Dynamics,
	ReflectionInput,
} from "./types.ts";
import {
	boundedId,
	MAX_AGENTS,
	MOOD_TTL_MS,
	validateAgentInput,
	validatePatch,
	validateReflection,
} from "./validation.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, personality TEXT NOT NULL, voice TEXT NOT NULL, profile TEXT NOT NULL, appearance TEXT NOT NULL, interests TEXT NOT NULL, avatar_id TEXT, evolution TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agent_dynamics (agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id), revision INTEGER NOT NULL, mood TEXT, interests TEXT NOT NULL, preferences TEXT NOT NULL, relationship TEXT NOT NULL, last_request_id TEXT) STRICT;
CREATE TABLE IF NOT EXISTS agent_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, created_at TEXT NOT NULL, source_entry_ids TEXT NOT NULL, summary TEXT NOT NULL, before_state TEXT, after_state TEXT, target_change_id INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS agent_receipts (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), request_id TEXT NOT NULL, PRIMARY KEY(agent_id, request_id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_authored_receipts (receipt_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), payload_hash TEXT NOT NULL, profile_json TEXT NOT NULL) STRICT;`;
const CANDIDATE_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_candidates (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, value TEXT NOT NULL, request_ids TEXT NOT NULL, PRIMARY KEY(agent_id, kind, value)) STRICT;`;
const MAX_PENDING_CANDIDATES = 32;
const MAX_PROMOTED_VALUES = 16;

type ProfileRow = Omit<AgentProfile, "interests" | "avatarId"> & {
	interests: string;
	avatar_id: string | null;
};
type DynamicsRow = {
	revision: number;
	mood: string | null;
	interests: string;
	preferences: string;
	relationship: string;
	last_request_id: string | null;
};
type ChangeRow = {
	id: number;
	kind: AgentChange["kind"];
	created_at: string;
	source_entry_ids: string;
	summary: string;
};

function json<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`corrupt ${label}`);
	}
}
function clone<T>(value: T): T {
	return structuredClone(value);
}

export class AgentStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private closed = false;

	constructor(path: string, now: () => number = Date.now) {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			typeof now !== "function"
		)
			throw new Error("invalid agent store arguments");
		this.now = now;
		this.db = new DatabaseSync(path);
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			this.assertNoForeignTables();
			for (const sql of `${SCHEMA}${CANDIDATE_SCHEMA}`.split(";"))
				if (sql.trim()) this.db.exec(sql);
			this.verifySchema();
			this.db.exec(
				"COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
			);
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			this.db.close();
			throw error;
		}
	}

	list(): AgentProfile[] {
		this.assertOpen();
		return (
			this.db
				.prepare("SELECT * FROM agent_profiles ORDER BY id")
				.all() as unknown as ProfileRow[]
		).map((row) => this.decodeProfile(row));
	}

	get(id: string): AgentProfile | undefined {
		this.assertOpen();
		if (typeof id !== "string") return undefined;
		const row = this.db
			.prepare("SELECT * FROM agent_profiles WHERE id = ?")
			.get(id) as ProfileRow | undefined;
		return row ? this.decodeProfile(row) : undefined;
	}

	create(input: AgentInput): AgentProfile {
		this.assertOpen();
		const value = validateAgentInput(input);
		return this.transaction(() => {
			if (
				(
					this.db.prepare("SELECT COUNT(*) AS n FROM agent_profiles").get() as {
						n: number;
					}
				).n >= MAX_AGENTS
			)
				throw new Error("agent capacity reached");
			if (this.get(value.id)) throw new Error("agent already exists");
			this.db
				.prepare(
					"INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.id,
					value.name,
					value.role,
					value.personality,
					value.voice,
					value.profile,
					value.appearance,
					JSON.stringify(value.interests),
					value.avatarId,
					value.evolution,
					1,
				);
			this.db
				.prepare(
					"INSERT INTO agent_dynamics VALUES (?, 0, NULL, '[]', '[]', '[]', NULL)",
				)
				.run(value.id);
			return { ...value, revision: 1 };
		});
	}

	update(
		id: string,
		expectedRevision: number,
		patch: Partial<Omit<AgentInput, "id">>,
	): AgentProfile {
		this.assertOpen();
		boundedId(id, "agent id");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
			throw new Error("invalid profile revision");
		const fields = validatePatch(patch);
		return this.transaction(() => {
			const current = this.get(id);
			if (!current) throw new Error("agent not found");
			if (current.revision !== expectedRevision)
				throw new Error("stale profile revision");
			const next = {
				...current,
				...fields,
				revision: current.revision + 1,
			} as AgentProfile;
			const { revision: _revision, ...nextInput } = next;
			const checked = validateAgentInput(nextInput);
			this.db
				.prepare(
					"UPDATE agent_profiles SET name=?, role=?, personality=?, voice=?, profile=?, appearance=?, interests=?, avatar_id=?, evolution=?, revision=? WHERE id=? AND revision=?",
				)
				.run(
					checked.name,
					checked.role,
					checked.personality,
					checked.voice,
					checked.profile,
					checked.appearance,
					JSON.stringify(checked.interests),
					checked.avatarId,
					checked.evolution,
					next.revision,
					id,
					expectedRevision,
				);
			this.db.prepare("DELETE FROM agent_candidates WHERE agent_id=?").run(id);
			this.addChange(id, "edit", [], "기본 설정 수정", null, null);
			return { ...checked, revision: current.revision + 1 };
		});
	}

	dynamics(id: string): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (!this.get(id)) throw new Error("agent not found");
		return this.decodeDynamics(
			this.db
				.prepare("SELECT * FROM agent_dynamics WHERE agent_id=?")
				.get(id) as DynamicsRow,
		);
	}

	applyReflection(
		id: string,
		input: ReflectionInput,
		validSource: (entryId: string) => boolean,
	): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (typeof validSource !== "function")
			throw new Error("invalid source validator");
		const value = validateReflection(input);
		return this.transaction(() => {
			const profile = this.get(id);
			if (!profile) throw new Error("agent not found");
			const current = this.dynamics(id);
			if (value.profileRevision !== profile.revision)
				throw new Error("stale profile revision");
			if (profile.evolution === "manual") return current;
			if (
				this.db
					.prepare(
						"SELECT 1 FROM agent_receipts WHERE agent_id=? AND request_id=?",
					)
					.get(id, value.requestId)
			)
				return current;
			if (value.dynamicsRevision !== current.revision)
				throw new Error("stale dynamics revision");
			if (value.sourceEntryIds.some((entryId) => !validSource(entryId)))
				throw new Error("reflection source is not a valid user entry");
			const interests = this.confirmCandidates(
				id,
				"interest",
				value.interests ?? [],
				current.interests,
				value.requestId,
			);
			const preferences = this.confirmCandidates(
				id,
				"preference",
				value.preferences ?? [],
				current.preferences,
				value.requestId,
			);
			const next: Dynamics = {
				revision: current.revision + 1,
				mood: value.mood
					? { ...value.mood, expiresAt: this.now() + MOOD_TTL_MS }
					: current.mood,
				interests,
				preferences,
				relationship: this.confirmCandidates(
					id,
					"relationship",
					value.relationship ?? [],
					current.relationship,
					value.requestId,
				),
				lastRequestId: value.requestId,
			};
			const visibleChanged = !isDeepStrictEqual(
				{
					mood: current.mood,
					interests: current.interests,
					preferences: current.preferences,
					relationship: current.relationship,
				},
				{
					mood: next.mood,
					interests: next.interests,
					preferences: next.preferences,
					relationship: next.relationship,
				},
			);
			if (!visibleChanged) {
				next.revision = current.revision;
				this.saveDynamics(id, next);
				this.db
					.prepare("INSERT INTO agent_receipts VALUES (?, ?)")
					.run(id, value.requestId);
				return next;
			}
			this.saveDynamics(id, next);
			this.db
				.prepare("INSERT INTO agent_receipts VALUES (?, ?)")
				.run(id, value.requestId);
			this.addChange(
				id,
				"reflection",
				value.sourceEntryIds,
				"대화에서 배운 변화",
				JSON.stringify(current),
				JSON.stringify(next),
			);
			return next;
		});
	}

	pendingGrowth(id: string): {
		interests: string[];
		preferences: string[];
		relationship: string[];
	} {
		this.assertOpen();
		boundedId(id, "agent id");
		const result = {
			interests: [] as string[],
			preferences: [] as string[],
			relationship: [] as string[],
		};
		const rows = this.db
			.prepare(
				"SELECT kind,value FROM agent_candidates WHERE agent_id=? ORDER BY rowid DESC LIMIT 96",
			)
			.all(id) as { kind: string; value: string }[];
		for (const row of rows) {
			const items =
				row.kind === "interest"
					? result.interests
					: row.kind === "preference"
						? result.preferences
						: result.relationship;
			if (items.length < 6) items.push(row.value);
		}
		return result;
	}

	changes(id: string): AgentChange[] {
		this.assertOpen();
		boundedId(id, "agent id");
		return (
			this.db
				.prepare(
					"SELECT id,kind,created_at,source_entry_ids,summary FROM agent_changes WHERE agent_id=? ORDER BY id DESC LIMIT 50",
				)
				.all(id) as unknown as ChangeRow[]
		).map((row) => ({
			id: row.id,
			kind: row.kind,
			createdAt: row.created_at,
			sourceEntryIds: json<string[]>(row.source_entry_ids, "change sources"),
			summary: row.summary,
		}));
	}

	revert(id: string, changeId: number, expectedRevision: number): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (
			!Number.isSafeInteger(changeId) ||
			changeId < 1 ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0
		)
			throw new Error("invalid revert arguments");
		return this.transaction(() => {
			const current = this.dynamics(id);
			if (current.revision !== expectedRevision)
				throw new Error("stale dynamics revision");
			const row = this.db
				.prepare("SELECT * FROM agent_changes WHERE id=? AND agent_id=?")
				.get(changeId, id) as
				| (ChangeRow & { before_state: string | null })
				| undefined;
			if (row?.kind !== "reflection" || !row.before_state)
				throw new Error("change is not revertible");
			if (
				this.db
					.prepare(
						"SELECT 1 FROM agent_changes WHERE agent_id=? AND target_change_id=?",
					)
					.get(id, changeId)
			)
				throw new Error("change already reverted");
			const restored = json<Dynamics>(row.before_state, "dynamics snapshot");
			restored.revision = current.revision + 1;
			this.saveDynamics(id, restored);
			this.addChange(
				id,
				"revert",
				[],
				"대화에서 배운 변화 되돌림",
				JSON.stringify(current),
				JSON.stringify(restored),
				changeId,
			);
			return this.dynamics(id);
		});
	}

	applyAuthored(
		input: AgentInput,
		expectedRevision: number | null,
		receiptId: string,
	): AgentProfile {
		this.assertOpen();
		const value = validateAgentInput(input);
		if (
			typeof receiptId !== "string" ||
			receiptId.length === 0 ||
			receiptId.includes("\u0000")
		)
			throw new Error("invalid authored receipt");
		if (
			expectedRevision !== null &&
			(!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
		)
			throw new Error("invalid profile revision");
		const payloadHash = createHash("sha256")
			.update(JSON.stringify(value))
			.digest("hex");
		return this.transaction(() => {
			const existing = this.db
				.prepare(
					"SELECT payload_hash, profile_json FROM agent_authored_receipts WHERE receipt_id=?",
				)
				.get(receiptId) as
				| { payload_hash: string; profile_json: string }
				| undefined;
			if (existing) {
				if (existing.payload_hash !== payloadHash)
					throw new Error("authored receipt conflict");
				return json<AgentProfile>(existing.profile_json, "authored receipt");
			}
			if (expectedRevision === null) {
				if (
					(
						this.db
							.prepare("SELECT COUNT(*) AS n FROM agent_profiles")
							.get() as { n: number }
					).n >= MAX_AGENTS
				)
					throw new Error("agent capacity reached");
				if (this.get(value.id)) throw new Error("agent already exists");
				this.db
					.prepare(
						"INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						value.id,
						value.name,
						value.role,
						value.personality,
						value.voice,
						value.profile,
						value.appearance,
						JSON.stringify(value.interests),
						value.avatarId,
						value.evolution,
						1,
					);
				this.db
					.prepare(
						"INSERT INTO agent_dynamics VALUES (?, 0, NULL, '[]', '[]', '[]', NULL)",
					)
					.run(value.id);
				const created: AgentProfile = { ...value, revision: 1 };
				this.db
					.prepare("INSERT INTO agent_authored_receipts VALUES (?, ?, ?, ?)")
					.run(receiptId, value.id, payloadHash, JSON.stringify(created));
				return created;
			}
			const current = this.get(value.id);
			if (!current) throw new Error("agent not found");
			if (current.revision !== expectedRevision)
				throw new Error("stale profile revision");
			const next: AgentProfile = {
				...value,
				revision: current.revision + 1,
			};
			this.db
				.prepare(
					"UPDATE agent_profiles SET name=?, role=?, personality=?, voice=?, profile=?, appearance=?, interests=?, avatar_id=?, evolution=?, revision=? WHERE id=? AND revision=?",
				)
				.run(
					value.name,
					value.role,
					value.personality,
					value.voice,
					value.profile,
					value.appearance,
					JSON.stringify(value.interests),
					value.avatarId,
					value.evolution,
					next.revision,
					value.id,
					expectedRevision,
				);
			this.db
				.prepare("DELETE FROM agent_candidates WHERE agent_id=?")
				.run(value.id);
			this.addChange(value.id, "edit", [], "기본 설정 수정", null, null);
			this.db
				.prepare("INSERT INTO agent_authored_receipts VALUES (?, ?, ?, ?)")
				.run(receiptId, value.id, payloadHash, JSON.stringify(next));
			return next;
		});
	}

	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}

	private decodeProfile(row: ProfileRow): AgentProfile {
		return {
			id: row.id,
			name: row.name,
			role: row.role,
			personality: row.personality,
			voice: row.voice,
			profile: row.profile,
			appearance: row.appearance,
			interests: json(row.interests, "profile interests"),
			avatarId: row.avatar_id,
			evolution: row.evolution,
			revision: row.revision,
		};
	}
	private decodeDynamics(row: DynamicsRow): Dynamics {
		const mood = row.mood ? json<Dynamics["mood"]>(row.mood, "mood") : null;
		return {
			revision: row.revision,
			mood: mood && mood.expiresAt <= this.now() ? null : mood,
			interests: json(row.interests, "interests"),
			preferences: json(row.preferences, "preferences"),
			relationship: json(row.relationship, "relationship"),
			lastRequestId: row.last_request_id,
		};
	}
	private saveDynamics(id: string, value: Dynamics): void {
		this.db
			.prepare(
				"UPDATE agent_dynamics SET revision=?,mood=?,interests=?,preferences=?,relationship=?,last_request_id=? WHERE agent_id=?",
			)
			.run(
				value.revision,
				value.mood ? JSON.stringify(value.mood) : null,
				JSON.stringify(value.interests),
				JSON.stringify(value.preferences),
				JSON.stringify(value.relationship),
				value.lastRequestId,
				id,
			);
	}
	private addChange(
		id: string,
		kind: AgentChange["kind"],
		sources: string[],
		summary: string,
		beforeState: string | null,
		afterState: string | null,
		targetChangeId: number | null = null,
	): void {
		this.db
			.prepare(
				"INSERT INTO agent_changes(agent_id,kind,created_at,source_entry_ids,summary,before_state,after_state,target_change_id) VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				id,
				kind,
				new Date(this.now()).toISOString(),
				JSON.stringify(sources),
				summary,
				beforeState,
				afterState,
				targetChangeId,
			);
	}
	private verifySchema(): void {
		const expected: Record<string, string[]> = {
			agent_profiles: [
				"id",
				"name",
				"role",
				"personality",
				"voice",
				"profile",
				"appearance",
				"interests",
				"avatar_id",
				"evolution",
				"revision",
			],
			agent_dynamics: [
				"agent_id",
				"revision",
				"mood",
				"interests",
				"preferences",
				"relationship",
				"last_request_id",
			],
			agent_changes: [
				"id",
				"agent_id",
				"kind",
				"created_at",
				"source_entry_ids",
				"summary",
				"before_state",
				"after_state",
				"target_change_id",
			],
			agent_receipts: ["agent_id", "request_id"],
			agent_authored_receipts: [
				"receipt_id",
				"agent_id",
				"payload_hash",
				"profile_json",
			],
			agent_candidates: ["agent_id", "kind", "value", "request_ids"],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const actual = (
				this.db.prepare(`PRAGMA table_info(${table})`).all() as {
					name: string;
				}[]
			).map((row) => row.name);
			if (!isDeepStrictEqual(actual, columns))
				throw new Error("unknown agent schema");
		}
	}
	private assertNoForeignTables(): void {
		const owned = new Set([
			"agent_profiles",
			"agent_dynamics",
			"agent_changes",
			"agent_receipts",
			"agent_authored_receipts",
			"agent_candidates",
		]);
		const tables = (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		if (tables.some((table) => !owned.has(table)))
			throw new Error("foreign agent database schema");
	}
	private confirmCandidates(
		id: string,
		kind: string,
		values: string[],
		existing: string[],
		requestId: string,
	): string[] {
		const result = [...existing];
		for (const value of values) {
			if (result.includes(value)) continue;
			const normalized = value.trim().toLocaleLowerCase();
			const row = this.db
				.prepare(
					"SELECT request_ids FROM agent_candidates WHERE agent_id=? AND kind=? AND value=?",
				)
				.get(id, kind, normalized) as { request_ids: string } | undefined;
			const ids = row
				? json<string[]>(row.request_ids, "candidate requests")
				: [];
			if (!ids.includes(requestId)) ids.push(requestId);
			if (ids.length >= 2) {
				if (result.length >= MAX_PROMOTED_VALUES) result.shift();
				result.push(normalized);
				this.db
					.prepare(
						"DELETE FROM agent_candidates WHERE agent_id=? AND kind=? AND value=?",
					)
					.run(id, kind, normalized);
			} else if (row)
				this.db
					.prepare(
						"UPDATE agent_candidates SET request_ids=? WHERE agent_id=? AND kind=? AND value=?",
					)
					.run(JSON.stringify(ids), id, kind, normalized);
			else {
				const count = (
					this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM agent_candidates WHERE agent_id=? AND kind=?",
						)
						.get(id, kind) as { count: number }
				).count;
				if (count >= MAX_PENDING_CANDIDATES)
					this.db
						.prepare(
							"DELETE FROM agent_candidates WHERE rowid = (SELECT rowid FROM agent_candidates WHERE agent_id=? AND kind=? ORDER BY rowid ASC LIMIT 1)",
						)
						.run(id, kind);
				this.db
					.prepare("INSERT INTO agent_candidates VALUES (?, ?, ?, ?)")
					.run(id, kind, normalized, JSON.stringify(ids));
			}
		}
		return result;
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return clone(result);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("agent store is closed");
	}
}
