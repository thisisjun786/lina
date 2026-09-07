import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../session-binding.ts";

export const PREFERENCE_DIMENSIONS = [
	"address",
	"register",
	"emoji",
	"questions",
	"verbosity",
	"support",
] as const;
export type PreferenceDimension = (typeof PREFERENCE_DIMENSIONS)[number];

export const PREFERENCE_VALUES = {
	address: ["neutral", "authored"] as const,
	register: ["polite", "casual", "authored"] as const,
	emoji: ["none", "sparing", "authored"] as const,
	questions: ["necessary", "open", "authored"] as const,
	verbosity: ["brief", "detailed", "authored"] as const,
	support: ["listen", "advice", "authored"] as const,
} as const satisfies Record<PreferenceDimension, readonly string[]>;
export type PreferenceValue =
	(typeof PREFERENCE_VALUES)[PreferenceDimension][number];

export interface ConversationExample {
	situation: string;
	response: string;
}

export interface ConversationProfile {
	revision: number;
	style: string;
	examples: ConversationExample[];
}

export interface ConversationProfilePatch {
	style?: string;
	examples?: ConversationExample[];
}

export interface UserSource {
	entryId: string;
	text: string;
	role: "user";
}

export interface PreferenceProposal {
	dimension: PreferenceDimension;
	value: PreferenceValue;
	quote: string;
}

export interface PreferenceItem extends PreferenceProposal {
	sourceEntryId: string;
	requestId: string;
}

export interface Preferences {
	revision: number;
	items: PreferenceItem[];
}

export type ValidSource = (entryId: string) => UserSource | undefined;

const SCHEMA_VERSION = 1;
const MAX_AGENT_ID = 160;
const MAX_REQUEST_ID = 160;
const MAX_SOURCE_ID = 160;
const MAX_STYLE = 1200;
const MAX_SITUATION = 240;
const MAX_RESPONSE = 400;
const MAX_EXAMPLES = 6;
const MAX_QUOTE = 300;
const MAX_PROPOSALS = 6;

const SCHEMA = `
CREATE TABLE conversation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE conversation_profiles (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1), style TEXT NOT NULL, examples_json TEXT NOT NULL) STRICT;
CREATE TABLE conversation_preferences (agent_id TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL, source_entry_id TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(agent_id, dimension)) STRICT;
CREATE TABLE conversation_preference_receipts (agent_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(agent_id, request_id)) STRICT;
`;

type ProfileRow = { revision: number; style: string; examples_json: string };
type PreferenceRow = Omit<PreferenceItem, "sourceEntryId" | "requestId"> & {
	source_entry_id: string;
	request_id: string;
};
type ReceiptRow = { fingerprint: string };

function object(
	value: unknown,
	allowed: readonly string[],
	label: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`invalid ${label}`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result))
		if (!allowed.includes(key))
			throw new Error(`unknown ${label} field ${key}`);
	return result;
}

function boundedString(
	value: unknown,
	label: string,
	max: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		value.length > max ||
		value.includes("\u0000") ||
		(!allowEmpty && value.length === 0)
	)
		throw new Error(`invalid ${label}`);
	return value;
}

function boundedId(value: unknown, label: string, max = MAX_AGENT_ID): string {
	return boundedString(value, label, max);
}

function field(row: Record<string, unknown> | undefined, key: string): unknown {
	return row?.[key];
}

function parseExamples(value: unknown): ConversationExample[] {
	if (!Array.isArray(value) || value.length > MAX_EXAMPLES)
		throw new Error("invalid profile examples");
	return value.map((example) => {
		const row = object(example, ["situation", "response"], "profile example");
		if (Object.keys(row).length !== 2)
			throw new Error("invalid profile example fields");
		return {
			situation: boundedString(
				field(row, "situation"),
				"example situation",
				MAX_SITUATION,
			),
			response: boundedString(
				field(row, "response"),
				"example response",
				MAX_RESPONSE,
			),
		};
	});
}

function parseProfilePatch(value: unknown): ConversationProfilePatch {
	const patch = object(value, ["style", "examples"], "profile patch");
	const result: ConversationProfilePatch = {};
	if ("style" in patch)
		result.style = boundedString(
			field(patch, "style"),
			"profile style",
			MAX_STYLE,
			true,
		);
	if ("examples" in patch)
		result.examples = parseExamples(field(patch, "examples"));
	return result;
}

function parseProposal(value: unknown): PreferenceProposal {
	const proposal = object(
		value,
		["dimension", "value", "quote"],
		"preference proposal",
	);
	if (Object.keys(proposal).length !== 3)
		throw new Error("invalid preference proposal fields");
	const dimension = boundedString(
		field(proposal, "dimension"),
		"preference dimension",
		32,
	) as PreferenceDimension;
	if (!(PREFERENCE_DIMENSIONS as readonly string[]).includes(dimension))
		throw new Error("unknown preference dimension");
	const valueText = boundedString(
		field(proposal, "value"),
		"preference value",
		32,
	);
	if (!(PREFERENCE_VALUES[dimension] as readonly string[]).includes(valueText))
		throw new Error("unknown preference value");
	return {
		dimension,
		value: valueText as PreferenceValue,
		quote: boundedString(
			field(proposal, "quote"),
			"preference quote",
			MAX_QUOTE,
		),
	};
}

function verifySchema(db: DatabaseSync): void {
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const expected = SCHEMA.split(";").map(normalize).filter(Boolean).sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => normalize(String(field(row, "sql"))))
		.sort();
	if (!isDeepStrictEqual(actual, expected))
		throw new Error("unknown conversation store schema");
}

function json<T>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`corrupt ${label}`);
	}
}

export class ConversationStore {
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		if (typeof path !== "string" || path.length === 0)
			throw new Error("invalid conversation store path");
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			const version = field(
				this.db.prepare("PRAGMA user_version").get(),
				"user_version",
			);
			const tables = this.db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
				)
				.all();
			if (opened.fresh && version === 0 && tables.length === 0) {
				this.db.exec(SCHEMA);
				this.db
					.prepare("INSERT INTO conversation_meta(key, value) VALUES (?, ?)")
					.run("schema_version", String(SCHEMA_VERSION));
				this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			} else {
				if (version !== SCHEMA_VERSION)
					throw new Error("unknown conversation store schema");
				verifySchema(this.db);
				const saved = this.db
					.prepare("SELECT value FROM conversation_meta WHERE key=?")
					.get("schema_version");
				const schemaVersion = field(saved, "value");
				if (schemaVersion !== String(SCHEMA_VERSION))
					throw new Error("unknown conversation store schema");
			}
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

	get(agentId: string): ConversationProfile {
		this.assertOpen();
		const id = boundedId(agentId, "agent id");
		const row = this.db
			.prepare(
				"SELECT revision, style, examples_json FROM conversation_profiles WHERE agent_id=?",
			)
			.get(id) as ProfileRow | undefined;
		return row
			? {
					revision: row.revision,
					style: row.style,
					examples: json<ConversationExample[]>(
						row.examples_json,
						"profile examples",
					),
				}
			: { revision: 0, style: "", examples: [] };
	}

	update(
		agentId: string,
		expectedRevision: number,
		patch: ConversationProfilePatch,
	): ConversationProfile {
		this.assertOpen();
		const id = boundedId(agentId, "agent id");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("invalid profile revision");
		const checked = parseProfilePatch(patch);
		return this.transaction(() => {
			const current = this.get(id);
			if (current.revision !== expectedRevision)
				throw new Error("stale profile revision");
			const next: ConversationProfile = {
				revision: current.revision + 1,
				style: checked.style ?? current.style,
				examples: checked.examples ?? current.examples,
			};
			this.db
				.prepare(
					"INSERT INTO conversation_profiles(agent_id, revision, style, examples_json) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision, style=excluded.style, examples_json=excluded.examples_json",
				)
				.run(id, next.revision, next.style, JSON.stringify(next.examples));
			return next;
		});
	}

	getPreferences(agentId: string): Preferences {
		this.assertOpen();
		const id = boundedId(agentId, "agent id");
		const revisionRow = this.db
			.prepare("SELECT value FROM conversation_meta WHERE key=?")
			.get(`preferences_revision:${id}`);
		const revision = Number(field(revisionRow, "value") ?? "0");
		const rows = this.db
			.prepare(
				"SELECT dimension, value, quote, source_entry_id, request_id FROM conversation_preferences WHERE agent_id=? ORDER BY dimension",
			)
			.all(id) as unknown as PreferenceRow[];
		return {
			revision,
			items: rows.map((row) => ({
				dimension: row.dimension,
				value: row.value,
				quote: row.quote,
				sourceEntryId: row.source_entry_id,
				requestId: row.request_id,
			})),
		};
	}

	hasPreferenceReceipt(agentId: string, requestId: string): boolean {
		this.assertOpen();
		return !!this.db
			.prepare(
				"SELECT 1 FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
			)
			.get(
				boundedId(agentId, "agent id"),
				boundedId(requestId, "request id", MAX_REQUEST_ID),
			);
	}
	preferenceResetAt(agentId: string): number {
		this.assertOpen();
		return Number(
			field(
				this.db
					.prepare("SELECT value FROM conversation_meta WHERE key=?")
					.get(`preferences_reset_at:${boundedId(agentId, "agent id")}`),
				"value",
			) ?? "0",
		);
	}

	observePreferences(
		agentId: string,
		requestId: string,
		sourceEntryId: string,
		sourceText: string,
		proposals: PreferenceProposal[],
		validSource: ValidSource,
		expectedRevision?: number,
	): Preferences {
		this.assertOpen();
		const id = boundedId(agentId, "agent id");
		const request = boundedId(requestId, "request id", MAX_REQUEST_ID);
		const sourceId = boundedId(sourceEntryId, "source entry id", MAX_SOURCE_ID);
		const text = boundedString(sourceText, "source text", 100_000);
		if (typeof validSource !== "function")
			throw new Error("invalid source validator");
		if (
			expectedRevision !== undefined &&
			(!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
		)
			throw new Error("invalid preferences revision");
		if (!Array.isArray(proposals) || proposals.length > MAX_PROPOSALS)
			throw new Error("invalid preference proposals");
		const checked = proposals.map(parseProposal);
		if (
			new Set(checked.map((proposal) => proposal.dimension)).size !==
			checked.length
		)
			throw new Error("duplicate preference dimension");
		for (const proposal of checked)
			if (!text.includes(proposal.quote))
				throw new Error("preference quote is not an exact source substring");
		const sourceTextHash = createHash("sha256").update(text).digest("hex");
		const fingerprint = JSON.stringify({
			sourceEntryId: sourceId,
			sourceTextHash,
			proposals: [...checked].sort((a, b) =>
				a.dimension.localeCompare(b.dimension),
			),
		});
		return this.transaction(() => {
			const receipt = this.db
				.prepare(
					"SELECT fingerprint FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
				)
				.get(id, request) as ReceiptRow | undefined;
			if (receipt) {
				if (receipt.fingerprint !== fingerprint)
					throw new Error("request already used");
				return this.getPreferences(id);
			}
			const source = validSource(sourceId);
			if (source?.role !== "user" || source.entryId !== sourceId)
				throw new Error("invalid user source");
			if (source.text !== text) throw new Error("source text mismatch");
			const current = this.getPreferences(id);
			if (
				expectedRevision !== undefined &&
				current.revision !== expectedRevision
			)
				throw new Error("stale preferences revision");
			this.db
				.prepare(
					"INSERT INTO conversation_preference_receipts(agent_id, request_id, fingerprint) VALUES (?, ?, ?)",
				)
				.run(id, request, fingerprint);
			for (const proposal of checked)
				this.db
					.prepare(
						"INSERT INTO conversation_preferences(agent_id, dimension, value, quote, source_entry_id, request_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, dimension) DO UPDATE SET value=excluded.value, quote=excluded.quote, source_entry_id=excluded.source_entry_id, request_id=excluded.request_id",
					)
					.run(
						id,
						proposal.dimension,
						proposal.value,
						proposal.quote,
						sourceId,
						request,
					);
			if (checked.length > 0)
				this.setPreferenceRevision(id, current.revision + 1);
			return this.getPreferences(id);
		});
	}

	clearPreferences(agentId: string, expectedRevision: number): Preferences {
		this.assertOpen();
		const id = boundedId(agentId, "agent id");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new Error("invalid preferences revision");
		return this.transaction(() => {
			const current = this.getPreferences(id);
			if (current.revision !== expectedRevision)
				throw new Error("stale preferences revision");
			this.db
				.prepare("DELETE FROM conversation_preferences WHERE agent_id=?")
				.run(id);
			this.setPreferenceRevision(id, current.revision + 1);
			this.db
				.prepare(
					"INSERT INTO conversation_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
				)
				.run(
					`preferences_reset_at:${id}`,
					String(Math.max(Date.now(), this.preferenceResetAt(id) + 1)),
				);
			return this.getPreferences(id);
		});
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}

	private setPreferenceRevision(agentId: string, revision: number): void {
		this.db
			.prepare(
				"INSERT INTO conversation_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			)
			.run(`preferences_revision:${agentId}`, String(revision));
	}

	private transaction<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("conversation store is closed");
	}
}
