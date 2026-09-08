import type { DatabaseSync } from "node:sqlite";
import type { LifeConfig } from "./authoring-types.ts";
import {
	parseLifeModelRecord,
	parseLifeModelResult,
	parseLifeModelUsage,
	parsePreparedLifeModel,
} from "./autonomy-record-validation.ts";
import type {
	LifeModelReconciliation,
	LifeModelRecord,
	LifeModelRequest,
	LifeUsageStatus,
	PreparedLifeModelRequest,
} from "./autonomy-types.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

type Row = {
	world_id: string;
	owner_id: string;
	existing_owner_id: string | null;
	request_id: string;
	record_json: string;
	digest: string;
};
const UNKNOWN = { inputTokens: null, outputTokens: null, totalTokens: null };
/** Reservations share the caller's transaction across both fixed owners. No network calls. */
export class LifeModelReceipts {
	private readonly table:
		| "life_model_receipts"
		| "life_publication_model_receipts";
	private readonly ownerTable: "life_steps" | "life_publication_jobs";
	private readonly ownerColumn: "step_id" | "job_id";
	constructor(
		private readonly db: DatabaseSync,
		private readonly clock: () => number,
		private readonly owner: "step" | "publication" = "step",
	) {
		if (owner !== "step" && owner !== "publication")
			throw Error("Invalid LIFE model receipt owner");
		this.table =
			owner === "step"
				? "life_model_receipts"
				: "life_publication_model_receipts";
		this.ownerTable = owner === "step" ? "life_steps" : "life_publication_jobs";
		this.ownerColumn = owner === "step" ? "step_id" : "job_id";
	}
	private requestOwnerId(request: LifeModelRequest): string {
		if (this.owner === "step" && request.version === 1) return request.stepId;
		if (this.owner === "publication" && request.version === 2)
			return request.jobId;
		throw Error("LIFE model request ownership mismatch");
	}
	private hasPublicationTable(): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='life_publication_model_receipts'",
				)
				.get() !== undefined
		);
	}
	private decode(row: Row): LifeModelRecord {
		const record = parseLifeModelRecord(JSON.parse(row.record_json)),
			request = record.prepared.request;
		if (
			row.world_id !== request.worldId ||
			row.owner_id !== this.requestOwnerId(request) ||
			row.existing_owner_id !== row.owner_id ||
			row.request_id !== request.id ||
			row.digest !== lifeDigest(record)
		)
			throw Error("Corrupt LIFE model receipt");
		return record;
	}
	private records(worldId?: string, ownerId?: string): LifeModelRecord[] {
		const conditions =
			worldId === undefined
				? ""
				: ` WHERE r.world_id = ?${ownerId === undefined ? "" : ` AND r.${this.ownerColumn} = ?`}`;
		const query = this.db.prepare(
			`SELECT r.world_id,r.${this.ownerColumn} AS owner_id,r.request_id,r.record_json,r.digest,
			 o.${this.ownerColumn} AS existing_owner_id FROM ${this.table} r
			 LEFT JOIN ${this.ownerTable} o ON o.world_id=r.world_id AND o.${this.ownerColumn}=r.${this.ownerColumn}
			 ${conditions} ORDER BY r.rowid`,
		);
		return (
			worldId === undefined
				? query.all()
				: ownerId === undefined
					? query.all(worldId)
					: query.all(worldId, ownerId)
		).map((row) => this.decode(row as Row));
	}
	list(worldId: string, ownerId?: string): LifeModelRecord[] {
		return this.records(
			identifier(worldId),
			ownerId === undefined ? undefined : identifier(ownerId),
		);
	}
	private shared(worldId?: string): LifeModelRecord[] {
		const records = this.records(worldId);
		// v5/v6 migration audits run before the publication table is installed.
		if (this.owner === "publication" || this.hasPublicationTable()) {
			const other = new LifeModelReceipts(
				this.db,
				this.clock,
				this.owner === "step" ? "publication" : "step",
			);
			records.push(...other.records(worldId));
		}
		const ids = new Set<string>();
		for (const {
			prepared: { request },
		} of records) {
			const key = `${request.worldId}:${request.id}`;
			if (ids.has(key)) throw Error("LIFE model request ownership conflict");
			ids.add(key);
		}
		return records;
	}
	get(worldId: string, ownerId: string, requestId: string): LifeModelRecord {
		const record = this.list(worldId, ownerId).find(
			(r) => r.prepared.request.id === requestId,
		);
		if (!record) throw Error("Unknown LIFE model request");
		return record;
	}
	private save(value: LifeModelRecord): LifeModelRecord {
		const record = parseLifeModelRecord(value),
			r = record.prepared.request,
			ownerId = this.requestOwnerId(r);
		const changed = this.db
			.prepare(
				`INSERT INTO ${this.table}(world_id,${this.ownerColumn},request_id,record_json,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,request_id) DO UPDATE SET record_json=excluded.record_json,digest=excluded.digest WHERE ${this.table}.${this.ownerColumn}=excluded.${this.ownerColumn}`,
			)
			.run(
				r.worldId,
				ownerId,
				r.id,
				canonicalLifeJson(record),
				lifeDigest(record),
			);
		if (changed.changes !== 1)
			throw Error("LIFE model request ownership conflict");
		return record;
	}
	usage(worldId: string, config: LifeConfig): LifeUsageStatus {
		return this.account(
			this.shared(identifier(worldId)),
			config.usage?.windowMs,
		);
	}
	private account(
		records: LifeModelRecord[],
		window?: number,
	): LifeUsageStatus {
		const result: LifeUsageStatus = {
			inputTokens: 0,
			outputTokens: 0,
			reservedInputTokens: 0,
			reservedOutputTokens: 0,
			unknownRequests: 0,
			upstreamAttempts: 0,
			monetaryCost: "unknown",
		};
		const now = revision(this.clock());
		for (const record of records) {
			const live =
				window === undefined ||
				(record.dispatchedAt ?? record.preparedAt) > now - window;
			const unresolved =
				record.status === "dispatched" ||
				record.status === "unknown" ||
				((record.status === "completed" ||
					(record.status === "failed" && record.upstreamAttempts !== 0)) &&
					(record.usage.inputTokens === null ||
						record.usage.outputTokens === null));
			if (record.status === "prepared" || unresolved) {
				result.reservedInputTokens += record.reservation.inputTokens;
				result.reservedOutputTokens += record.reservation.outputTokens;
				if (unresolved) result.unknownRequests++;
			}
			if (live && record.status !== "prepared") {
				result.inputTokens += record.usage.inputTokens ?? 0;
				result.outputTokens += record.usage.outputTokens ?? 0;
				result.upstreamAttempts += record.upstreamAttempts ?? 0;
			}
		}
		for (const [key, value] of Object.entries(result))
			if (key !== "monetaryCost") revision(value);
		return result;
	}
	cancelPrepared(worldId: string, ownerId: string, reason: string): void {
		for (const record of this.list(worldId, ownerId)) {
			if (record.status !== "prepared") continue;
			this.save({
				...record,
				status: "failed",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				upstreamAttempts: 0,
				error: reason,
			});
		}
	}
	prepare(
		value: PreparedLifeModelRequest,
		config: LifeConfig,
	): LifeModelRecord {
		const prepared = parsePreparedLifeModel(value),
			r = prepared.request;
		this.requestOwnerId(r);
		const records = this.shared(r.worldId);
		const prior = records.find((record) => record.prepared.request.id === r.id);
		if (prior) {
			this.requestOwnerId(prior.prepared.request);
			if (lifeDigest(prior.prepared) !== lifeDigest(prepared))
				throw Error("LIFE model preparation conflict");
			return prior;
		}
		const usage = this.account(records, config.usage?.windowMs),
			budget = config.usage;
		if (
			!budget ||
			usage.unknownRequests ||
			usage.inputTokens + usage.reservedInputTokens + r.limits.maxInputTokens >
				budget.maxInputTokens ||
			usage.outputTokens +
				usage.reservedOutputTokens +
				r.limits.maxOutputTokens >
				budget.maxOutputTokens
		)
			throw Error("LIFE model budget exhausted or uncertain");
		return this.save({
			prepared,
			status: "prepared",
			preparedAt: revision(this.clock()),
			dispatchedAt: null,
			result: null,
			usage: { ...UNKNOWN },
			reservation: {
				inputTokens: r.limits.maxInputTokens,
				outputTokens: r.limits.maxOutputTokens,
			},
			upstreamAttempts: 0,
			error: null,
		});
	}
	dispatch(
		worldId: string,
		ownerId: string,
		requestId: string,
		config?: LifeConfig,
	): { record: LifeModelRecord; dispatched: boolean } {
		const record = this.get(worldId, ownerId, requestId);
		if (record.status !== "prepared") return { record, dispatched: false };
		this.assertSharedDispatch(record, config);
		return {
			record: this.save({
				...record,
				status: "dispatched",
				dispatchedAt: revision(this.clock()),
				upstreamAttempts: null,
			}),
			dispatched: true,
		};
	}
	/** The caller still owns lease/source/route checks; this fences both spend ledgers. */
	assertOutbound(request: LifeModelRequest, config: LifeConfig): void {
		const record = this.get(
			request.worldId,
			this.requestOwnerId(request),
			request.id,
		);
		if (
			record.status !== "dispatched" ||
			lifeDigest(record.prepared.request) !== lifeDigest(request)
		)
			throw Error("LIFE outbound requires its exact dispatched receipt");
		this.assertSharedDispatch(record, config);
	}
	private assertSharedDispatch(
		record: LifeModelRecord,
		config?: LifeConfig,
	): void {
		const request = record.prepared.request;
		if (config && config.worldId !== request.worldId)
			throw Error("LIFE model budget world mismatch");
		// A request's own dispatched marker is intentionally uncertain until its
		// response arrives. Exempt only that ID, never another lane or owner.
		const usage = this.account(
			this.shared(request.worldId).filter(
				(other) => other.prepared.request.id !== request.id,
			),
			config?.usage?.windowMs,
		);
		const budget = config?.usage;
		if (
			usage.unknownRequests ||
			(config &&
				(!budget ||
					usage.inputTokens +
						usage.reservedInputTokens +
						record.reservation.inputTokens >
						budget.maxInputTokens ||
					usage.outputTokens +
						usage.reservedOutputTokens +
						record.reservation.outputTokens >
						budget.maxOutputTokens))
		)
			throw Error("LIFE model budget exhausted or uncertain");
	}
	finish(
		worldId: string,
		ownerId: string,
		requestId: string,
		value: LifeModelReconciliation,
	): LifeModelRecord {
		const record = this.get(worldId, ownerId, requestId);
		if (value.status === "not_dispatched") {
			fields(value, ["status"]);
			if (record.status !== "prepared")
				throw Error("No-dispatch proof conflicts with durable dispatch");
			return record;
		}
		if (record.dispatchedAt === null)
			throw Error("LIFE model was not dispatched");
		let next: LifeModelRecord;
		if (value.status === "completed") {
			fields(value, ["status", "result"]);
			const result = parseLifeModelResult(value.result, record.prepared);
			next = {
				...record,
				status: "completed",
				result,
				usage: result.usage,
				upstreamAttempts: 1,
				error: null,
			};
		} else if (value.status === "failed") {
			fields(value, ["status", "usage", "upstreamAttempts", "reason"]);
			next = {
				...record,
				status: "failed",
				result: null,
				usage: parseLifeModelUsage(value.usage),
				upstreamAttempts: value.upstreamAttempts,
				error: value.reason,
			};
		} else if (value.status === "unknown") {
			const accounted =
				Object.hasOwn(value, "usage") ||
				Object.hasOwn(value, "upstreamAttempts");
			fields(
				value,
				accounted ? ["status", "usage", "upstreamAttempts"] : ["status"],
			);
			if (record.status === "completed" || record.status === "failed")
				return record;
			next = { ...record, status: "unknown" };
			if (accounted) {
				if (value.upstreamAttempts !== 0 && value.upstreamAttempts !== 1)
					throw Error("Invalid uncertain LIFE attempt count");
				const usage = parseLifeModelUsage(value.usage);
				for (const key of [
					"inputTokens",
					"outputTokens",
					"totalTokens",
				] as const) {
					if (
						record.usage[key] !== null &&
						usage[key] !== null &&
						record.usage[key] !== usage[key]
					)
						throw Error("LIFE recovered usage conflict");
					usage[key] ??= record.usage[key];
				}
				if (record.upstreamAttempts === 1 && value.upstreamAttempts !== 1)
					throw Error("LIFE upstream attempts regressed");
				next = { ...next, usage, upstreamAttempts: value.upstreamAttempts };
			}
		} else throw Error("Invalid LIFE model reconciliation");
		if (record.status === "completed" || record.status === "failed") {
			if (lifeDigest(record) !== lifeDigest(next))
				throw Error("LIFE model result conflict");
			return record;
		}
		for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const)
			if (record.usage[key] !== null && record.usage[key] !== next.usage[key])
				throw Error("LIFE model accounting conflict");
		if (record.upstreamAttempts === 1 && next.upstreamAttempts !== 1)
			throw Error("LIFE upstream attempts regressed");
		return this.save(next);
	}
	audit(): void {
		const worlds = new Map<string, LifeModelRecord[]>();
		for (const record of this.shared()) {
			const worldId = record.prepared.request.worldId;
			const records = worlds.get(worldId) ?? [];
			records.push(record);
			worlds.set(worldId, records);
		}
		for (const records of worlds.values()) this.account(records);
	}
}
