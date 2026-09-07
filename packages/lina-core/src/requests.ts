import type { DatabaseSync } from "node:sqlite";
import {
	REQUEST_MAX_CHARS,
	type RequestRecord,
	type RequestStatus,
} from "./protocol.ts";

interface RequestRow {
	id: string;
	session_id: string;
	text: string;
	status: RequestStatus;
	created_at: string;
	updated_at: string;
	error: string | null;
	entry_id: string | null;
}

export interface RequestDetails {
	entryId?: string;
	error?: string;
}

const transitions: Record<RequestStatus, readonly RequestStatus[]> = {
	queued: ["accepted", "rejected", "interrupted"],
	accepted: ["settled", "interrupted"],
	settled: [],
	rejected: [],
	interrupted: [],
};

function record(row: RequestRow): RequestRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		text: row.text,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.error === null ? {} : { error: row.error }),
		...(row.entry_id === null ? {} : { entryId: row.entry_id }),
	};
}

export class Requests {
	private readonly lookup;
	private readonly recent;
	private readonly insert;
	private readonly update;
	private readonly interrupt;

	constructor(
		db: DatabaseSync,
		private readonly sessionId: string,
	) {
		this.lookup = db.prepare("SELECT * FROM requests WHERE id = ?");
		this.recent = db.prepare(
			"SELECT * FROM requests ORDER BY rowid DESC LIMIT ?",
		);
		this.insert =
			db.prepare(`INSERT INTO requests (id, session_id, text, status, created_at, updated_at)
			VALUES (?, ?, ?, 'queued', ?, ?)`);
		this.update = db.prepare(
			"UPDATE requests SET status = ?, entry_id = ?, error = ?, updated_at = ? WHERE id = ?",
		);
		this.interrupt = db.prepare(
			"UPDATE requests SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'accepted')",
		);
	}

	request(id: string): RequestRecord | undefined {
		// Owned schema guarantees the types in this SQLite projection.
		const row = this.lookup.get(id) as RequestRow | undefined;
		return row ? record(row) : undefined;
	}

	requests(limit = 20): RequestRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("invalid request limit");
		return (
			this.recent.all(Math.min(limit, 200)) as unknown as RequestRow[]
		).map(record);
	}

	create(
		id: string,
		text: string,
	): { request: RequestRecord; created: boolean } {
		if (id.trim().length === 0 || id.length > 128)
			throw new Error("invalid request ID");
		if (text.trim().length === 0)
			throw new Error("request text must not be blank");
		if (text.length > REQUEST_MAX_CHARS)
			throw new Error("request text exceeds 16000 characters");
		const existing = this.request(id);
		if (existing) {
			if (existing.text !== text) throw new Error("request ID conflict");
			return { request: existing, created: false };
		}
		const now = new Date().toISOString();
		this.insert.run(id, this.sessionId, text, now, now);
		return {
			request: {
				id,
				sessionId: this.sessionId,
				text,
				status: "queued",
				createdAt: now,
				updatedAt: now,
			},
			created: true,
		};
	}

	set(
		id: string,
		status: RequestStatus,
		details: RequestDetails = {},
	): { request: RequestRecord; changed: boolean } {
		const current = this.request(id);
		if (!current) throw new Error("request not found");
		const entryId = details.entryId ?? current.entryId;
		const error = details.error ?? current.error;
		const unchanged =
			status === current.status &&
			entryId === current.entryId &&
			error === current.error;
		if (unchanged) return { request: current, changed: false };
		if (
			transitions[current.status].length === 0 ||
			(status !== current.status &&
				!transitions[current.status].includes(status))
		) {
			throw new Error(
				`invalid request transition: ${current.status} -> ${status}`,
			);
		}
		if (current.entryId !== undefined && entryId !== current.entryId)
			throw new Error("request entry ID conflict");
		const updatedAt = new Date().toISOString();
		this.update.run(status, entryId ?? null, error ?? null, updatedAt, id);
		return {
			request: {
				...current,
				status,
				updatedAt,
				...(entryId === undefined ? {} : { entryId }),
				...(error === undefined ? {} : { error }),
			},
			changed: true,
		};
	}

	recover(): number {
		return Number(this.interrupt.run(new Date().toISOString()).changes);
	}
}
