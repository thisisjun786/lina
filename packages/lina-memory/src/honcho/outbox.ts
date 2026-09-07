import type { DatabaseSync } from "node:sqlite";
import {
	openCheckedDatabase,
	validateBinding,
} from "../../../lina-core/src/session-binding.ts";
import { chunkText } from "./chunk.ts";
import { initializeOutbox } from "./outbox-schema.ts";
import type {
	BotBinding,
	HonchoIdentity,
	OutboxCounts,
	OutboxPart,
	OutboxRole,
	OutboxState,
	ScanState,
} from "./types.ts";

const STATES: readonly OutboxState[] = [
	"pending",
	"sending",
	"accepted",
	"unknown",
	"failed",
];

function row(value: Record<string, unknown>): OutboxPart {
	const part: OutboxPart = {
		id: Number(value["id"]),
		entryId: String(value["entry_id"]),
		partIndex: Number(value["part_index"]),
		role: value["role"] as OutboxRole,
		content: String(value["content"]),
		contentHash: String(value["content_hash"]),
		state: value["state"] as OutboxState,
	};
	if (typeof value["remote_id"] === "string")
		part.remoteId = value["remote_id"];
	if (typeof value["error"] === "string") part.error = value["error"];
	return part;
}

function checkId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error("invalid outbox id");
	return value;
}

export class HonchoOutbox {
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(path: string, binding: BotBinding, identity: HonchoIdentity) {
		const owner = {
			binding: validateBinding(binding),
			identity: { ...identity },
		};
		for (const key of Object.keys(identity) as (keyof HonchoIdentity)[])
			checkId(identity[key]);
		if (Object.keys(identity).length !== 5) throw new Error("invalid identity");
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		let transaction = false;
		try {
			this.db.exec("BEGIN IMMEDIATE");
			transaction = true;
			initializeOutbox(this.db, owner, opened.fresh);
			this.db.exec("COMMIT");
			transaction = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (transaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	private open(): DatabaseSync {
		if (this.closed) throw new Error("outbox is closed");
		return this.db;
	}

	private transaction<T>(work: () => T): T {
		const db = this.open();
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	// Deterministic and idempotent: the same entry always yields the same parts, and a
	// differing replay for a known entry is a visible error, never a silent overwrite.
	enqueue(
		entryId: string,
		role: OutboxRole,
		text: string,
	): { parts: number; inserted: number } {
		checkId(entryId);
		if (role !== "user" && role !== "assistant")
			throw new Error("invalid outbox role");
		if (typeof text !== "string") throw new Error("invalid outbox text");
		const parts = chunkText(text);
		return this.transaction(() => {
			const existing = this.db
				.prepare(
					"SELECT part_index, role, content_hash FROM parts WHERE entry_id = ? ORDER BY part_index",
				)
				.all(entryId);
			if (existing.length > 0) {
				const same =
					existing.length === parts.length &&
					existing.every(
						(found, index) =>
							found["part_index"] === index &&
							found["role"] === role &&
							found["content_hash"] === parts[index]?.contentHash,
					);
				if (!same)
					throw new Error(`outbox entry ${entryId} differs from replay`);
				return { parts: parts.length, inserted: 0 };
			}
			const insert = this.db.prepare(
				"INSERT INTO parts(entry_id, part_index, role, content, content_hash, state) VALUES (?, ?, ?, ?, ?, 'pending')",
			);
			parts.forEach((part, index) => {
				insert.run(entryId, index, role, part.content, part.contentHash);
			});
			return { parts: parts.length, inserted: parts.length };
		});
	}

	private select(state: OutboxState, limit: number): OutboxPart[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("invalid outbox limit");
		return this.open()
			.prepare("SELECT * FROM parts WHERE state = ? ORDER BY id LIMIT ?")
			.all(state, limit)
			.map(row);
	}

	next(limit = 20): OutboxPart[] {
		return this.select("pending", limit);
	}

	unknown(limit = 20): OutboxPart[] {
		return this.select("unknown", limit);
	}

	part(id: number): OutboxPart | undefined {
		const found = this.open()
			.prepare("SELECT * FROM parts WHERE id = ?")
			.get(id);
		return found ? row(found) : undefined;
	}

	private move(
		id: number,
		from: readonly OutboxState[],
		to: OutboxState,
		remoteId: string | null,
		error: string | null,
	): void {
		if (!Number.isSafeInteger(id)) throw new Error("invalid outbox part id");
		const placeholders = from.map(() => "?").join(",");
		const changed = this.open()
			.prepare(
				`UPDATE parts SET state = ?, remote_id = ?, error = ? WHERE id = ? AND state IN (${placeholders})`,
			)
			.run(to, remoteId, error, id, ...from).changes;
		if (changed !== 1)
			throw new Error(`outbox part ${id} is not in ${from.join("/")}`);
	}

	// Committed before the POST so a crash lands in unknown, never a blind resend.
	markSending(id: number): void {
		this.move(id, ["pending"], "sending", null, null);
	}

	markPending(id: number, reason: string): void {
		this.move(id, ["sending"], "pending", null, reason);
	}

	markAccepted(id: number, remoteId: string): void {
		this.move(id, ["sending", "unknown"], "accepted", checkId(remoteId), null);
	}

	markUnknown(id: number, reason: string): void {
		this.move(id, ["sending", "unknown"], "unknown", null, reason);
	}

	markFailed(id: number, reason: string): void {
		this.move(id, ["sending", "unknown", "pending"], "failed", null, reason);
	}

	counts(): OutboxCounts {
		const counts: OutboxCounts = {
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			failed: 0,
		};
		for (const found of this.open()
			.prepare("SELECT state, COUNT(*) AS n FROM parts GROUP BY state")
			.all()) {
			const state = found["state"];
			if (STATES.includes(state as OutboxState))
				counts[state as OutboxState] = Number(found["n"]);
		}
		return counts;
	}

	scanState(): ScanState {
		const found = this.open()
			.prepare("SELECT after, eligible_user FROM scan WHERE id = 1")
			.get();
		if (!found) throw new Error("outbox scan state is missing");
		return {
			after: Number(found["after"]),
			eligibleUser: found["eligible_user"] === 1,
		};
	}

	setScanState(state: ScanState): void {
		if (
			typeof state !== "object" ||
			state === null ||
			Object.keys(state).length !== 2 ||
			!Number.isSafeInteger(state.after) ||
			state.after < 0 ||
			typeof state.eligibleUser !== "boolean"
		)
			throw new Error("invalid scan state");
		this.open()
			.prepare("UPDATE scan SET after = ?, eligible_user = ? WHERE id = 1")
			.run(state.after, state.eligibleUser ? 1 : 0);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
