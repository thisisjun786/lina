import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../session-binding.ts";
import type { SourceLookup, SourceProof } from "../source-policy.ts";
import { initializeConversation } from "./conversation-schema.ts";
import {
	assertLearnedProvenance,
	type LearnedProvenance,
	parseLearnedProofs,
	unionLearnedProofs,
} from "./learned-provenance.ts";
import { learnedReceiptHash } from "./learned-receipt.ts";

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

const MAX_AGENT_ID = 160;
const MAX_REQUEST_ID = 160;
const MAX_SOURCE_ID = 160;
const MAX_STYLE = 1200;
const MAX_SITUATION = 240;
const MAX_RESPONSE = 400;
const MAX_EXAMPLES = 6;
const MAX_QUOTE = 300;
const MAX_PROPOSALS = 6;

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
			initializeConversation(this.db, opened.fresh, (version) =>
				this.auditData(version),
			);
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

	modelPreferences(
		agentId: string,
		lookup: SourceLookup,
	): Preferences & { sourceProofs: SourceProof[] } {
		const current = this.getPreferences(agentId);
		const proofs: SourceProof[][] = [];
		const items = current.items.filter((item) => {
			const p = this.preferenceProofs(agentId, item.requestId, lookup);
			if (!p) return false;
			proofs.push(p);
			return true;
		});
		return { ...current, items, sourceProofs: unionLearnedProofs(...proofs) };
	}
	private preferenceProofs(
		agentId: string,
		requestId: string,
		lookup: SourceLookup,
	): SourceProof[] | undefined {
		this.assertOpen();
		const row = this.db
			.prepare(
				"SELECT s.source_proofs,r.fingerprint FROM conversation_preference_sources s JOIN conversation_preference_receipts r USING(agent_id,request_id) WHERE s.agent_id=? AND s.request_id=?",
			)
			.get(boundedId(agentId, "agent id"), boundedId(requestId, "request id"));
		if (!row) return undefined;
		const proofs = parseLearnedProofs(JSON.parse(String(row["source_proofs"])));
		const receipt = this.checkedReceipt(
			agentId,
			requestId,
			String(row["fingerprint"]),
			proofs,
		);
		if (!receipt.bound) return undefined;
		try {
			assertLearnedProvenance({ sourceProofs: proofs, lookup }, requestId, [
				receipt.sourceEntryId,
			]);
			return proofs;
		} catch {
			return undefined;
		}
	}
	hasPreferenceReceipt(
		agentId: string,
		requestId: string,
		lookup?: SourceLookup,
	): boolean {
		if (lookup)
			return this.preferenceProofs(agentId, requestId, lookup) !== undefined;
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
		provenance?: LearnedProvenance,
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
		const proofs = provenance
			? assertLearnedProvenance(provenance, request, [sourceId], text)
			: undefined;
		const receiptInput = {
			sourceEntryId: sourceId,
			sourceTextHash,
			proposals: [...checked].sort((a, b) =>
				a.dimension.localeCompare(b.dimension),
			),
		};
		const fingerprint = JSON.stringify({
			...receiptInput,
			...(proofs
				? {
						provenance: {
							version: 1,
							hash: learnedReceiptHash(
								"preference",
								id,
								request,
								receiptInput,
								proofs,
							),
						},
					}
				: {}),
		});
		return this.transaction(() => {
			const receipt = this.db
				.prepare(
					"SELECT fingerprint FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
				)
				.get(id, request) as ReceiptRow | undefined;
			if (receipt) {
				if (
					provenance &&
					(!this.hasPreferenceReceipt(id, request, provenance.lookup) ||
						!isDeepStrictEqual(
							this.preferenceProofs(id, request, provenance.lookup),
							proofs,
						))
				)
					throw Error("ineligible or conflicting preference receipt");
				if (receipt.fingerprint !== fingerprint)
					throw new Error("request already used");
				return this.getPreferences(id);
			}
			const source = validSource(sourceId);
			if (provenance)
				assertLearnedProvenance(provenance, request, [sourceId], text);
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
			if (proofs)
				this.db
					.prepare("INSERT INTO conversation_preference_sources VALUES(?,?,?)")
					.run(id, request, JSON.stringify(proofs));
			this.archivePreferences(id, current, "observe");
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
			if (provenance)
				assertLearnedProvenance(provenance, request, [sourceId], text);
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
			this.archivePreferences(id, current, "reset");
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

	private archivePreferences(
		id: string,
		value: Preferences,
		event: string,
	): void {
		this.db
			.prepare(
				"INSERT INTO conversation_preference_history(agent_id,revision,event,data) VALUES(?,?,?,?)",
			)
			.run(id, value.revision, event, JSON.stringify(value));
	}
	/** New v1 receipt metadata binds the original payload and complete proof projection. */
	private checkedReceipt(
		agentId: string,
		requestId: string,
		fingerprint: string,
		proofs?: SourceProof[],
	) {
		const receipt = object(
			JSON.parse(fingerprint),
			["sourceEntryId", "sourceTextHash", "proposals", "provenance"],
			"preference receipt",
		);
		const sourceEntryId = boundedId(receipt["sourceEntryId"], "source id"),
			sourceTextHash = receipt["sourceTextHash"];
		if (
			typeof sourceTextHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(sourceTextHash) ||
			!Array.isArray(receipt["proposals"])
		)
			throw Error("invalid preference receipt");
		const proposals = receipt["proposals"]
			.map(parseProposal)
			.sort((a, b) => a.dimension.localeCompare(b.dimension));
		if (
			proposals.length > MAX_PROPOSALS ||
			new Set(proposals.map((p) => p.dimension)).size !== proposals.length
		)
			throw Error("invalid preference receipt proposals");
		const input = { sourceEntryId, sourceTextHash, proposals },
			bound = Object.hasOwn(receipt, "provenance");
		if (bound) {
			const provenance = object(
				receipt["provenance"],
				["version", "hash"],
				"preference receipt provenance",
			);
			if (
				Object.keys(provenance).length !== 2 ||
				provenance["version"] !== 1 ||
				!proofs ||
				provenance["hash"] !==
					learnedReceiptHash("preference", agentId, requestId, input, proofs)
			)
				throw Error("invalid preference receipt proof integrity");
		}
		return { ...input, bound };
	}

	private auditData(version: number): void {
		for (const row of this.db
			.prepare(
				"SELECT agent_id,revision,style,examples_json FROM conversation_profiles",
			)
			.iterate()) {
			boundedId(row["agent_id"], "agent id");
			if (!Number.isSafeInteger(row["revision"]) || Number(row["revision"]) < 1)
				throw Error("invalid conversation revision");
			boundedString(row["style"], "style", MAX_STYLE, true);
			parseExamples(JSON.parse(String(row["examples_json"])));
		}
		for (const row of this.db
			.prepare("SELECT key,value FROM conversation_meta")
			.iterate()) {
			const key = String(row["key"]),
				value = Number(row["value"]);
			if (
				!Number.isSafeInteger(value) ||
				value < 0 ||
				(!key.startsWith("preferences_revision:") &&
					!key.startsWith("preferences_reset_at:") &&
					key !== "schema_version")
			)
				throw Error("invalid conversation metadata");
		}
		for (const row of this.db
			.prepare(
				"SELECT agent_id,request_id,fingerprint FROM conversation_preference_receipts",
			)
			.iterate()) {
			boundedId(row["agent_id"], "agent id");
			boundedId(row["request_id"], "request id");
			const proofRow =
				version === 2
					? this.db
							.prepare(
								"SELECT source_proofs FROM conversation_preference_sources WHERE agent_id=? AND request_id=?",
							)
							.get(String(row["agent_id"]), String(row["request_id"]))
					: undefined;
			this.checkedReceipt(
				String(row["agent_id"]),
				String(row["request_id"]),
				String(row["fingerprint"]),
				proofRow
					? parseLearnedProofs(JSON.parse(String(proofRow["source_proofs"])))
					: undefined,
			);
		}
		for (const row of this.db
			.prepare(
				"SELECT agent_id,dimension,value,quote,source_entry_id,request_id FROM conversation_preferences",
			)
			.iterate()) {
			const proposal = parseProposal({
				dimension: row["dimension"],
				value: row["value"],
				quote: row["quote"],
			});
			const receipt = this.db
				.prepare(
					"SELECT fingerprint FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
				)
				.get(String(row["agent_id"]), String(row["request_id"]));
			if (!receipt) throw Error("orphan preference");
			const data = JSON.parse(String(receipt["fingerprint"])) as {
				sourceEntryId: string;
				proposals: PreferenceProposal[];
			};
			if (
				data.sourceEntryId !== row["source_entry_id"] ||
				!data.proposals.some((p) => isDeepStrictEqual(p, proposal))
			)
				throw Error("invalid preference projection");
		}
		if (version === 2) {
			for (const row of this.db
				.prepare(
					"SELECT agent_id,request_id,source_proofs FROM conversation_preference_sources",
				)
				.iterate()) {
				const proofs = parseLearnedProofs(
					JSON.parse(String(row["source_proofs"])),
				);
				const receipt = this.db
					.prepare(
						"SELECT fingerprint FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
					)
					.get(String(row["agent_id"]), String(row["request_id"]));
				if (
					!receipt ||
					!proofs.some(
						(p) =>
							p.entryId ===
							(
								JSON.parse(String(receipt["fingerprint"])) as {
									sourceEntryId: string;
								}
							).sourceEntryId,
					)
				)
					throw Error("invalid preference source projection");
			}
			for (const row of this.db
				.prepare(
					"SELECT agent_id,revision,data FROM conversation_preference_history",
				)
				.iterate()) {
				const raw = object(
					JSON.parse(String(row["data"])),
					["revision", "items"],
					"preference history",
				);
				const value = raw as unknown as Preferences;
				if (
					Object.keys(raw).length !== 2 ||
					value.revision !== row["revision"] ||
					!Array.isArray(value.items) ||
					value.items.length > MAX_PROPOSALS ||
					new Set(value.items.map((item) => item.dimension)).size !==
						value.items.length
				)
					throw Error("invalid preference history");
				boundedId(row["agent_id"], "history agent");
				for (const item of value.items) {
					const fields = object(
						item,
						["dimension", "value", "quote", "sourceEntryId", "requestId"],
						"preference history item",
					);
					if (Object.keys(fields).length !== 5)
						throw Error("invalid preference history fields");
					boundedId(item.sourceEntryId, "history source");
					boundedId(item.requestId, "history request");
					const proposal = parseProposal({
						dimension: item.dimension,
						value: item.value,
						quote: item.quote,
					});
					const receipt = this.db
						.prepare(
							"SELECT fingerprint FROM conversation_preference_receipts WHERE agent_id=? AND request_id=?",
						)
						.get(String(row["agent_id"]), item.requestId);
					if (!receipt) throw Error("orphan preference history");
					const saved = JSON.parse(String(receipt["fingerprint"])) as {
						sourceEntryId: string;
						proposals: PreferenceProposal[];
					};
					if (
						saved.sourceEntryId !== item.sourceEntryId ||
						!saved.proposals.some((p) => isDeepStrictEqual(p, proposal))
					)
						throw Error("invalid preference history projection");
				}
			}
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
