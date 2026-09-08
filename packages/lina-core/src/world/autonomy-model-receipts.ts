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
	step_id: string;
	request_id: string;
	record_json: string;
	digest: string;
};
const UNKNOWN = { inputTokens: null, outputTokens: null, totalTokens: null };
/** Durable reservations survive lease loss and configuration/window changes. No network calls. */
export class LifeModelReceipts {
	constructor(
		private readonly db: DatabaseSync,
		private readonly clock: () => number,
	) {}
	private decode(row: Row): LifeModelRecord {
		const record = parseLifeModelRecord(JSON.parse(row.record_json)),
			request = record.prepared.request;
		if (
			row.world_id !== request.worldId ||
			row.step_id !== request.stepId ||
			row.request_id !== request.id ||
			row.digest !== lifeDigest(record)
		)
			throw Error("Corrupt LIFE model receipt");
		return record;
	}
	list(worldId: string, stepId?: string): LifeModelRecord[] {
		identifier(worldId);
		const query = this.db.prepare(
			`SELECT * FROM life_model_receipts WHERE world_id = ?${stepId === undefined ? "" : " AND step_id = ?"} ORDER BY rowid`,
		);
		return (
			stepId === undefined
				? query.all(worldId)
				: query.all(worldId, identifier(stepId))
		).map((row) => this.decode(row as Row));
	}
	get(worldId: string, stepId: string, requestId: string): LifeModelRecord {
		const record = this.list(worldId, stepId).find(
			(r) => r.prepared.request.id === requestId,
		);
		if (!record) throw Error("Unknown LIFE model request");
		return record;
	}
	private save(value: LifeModelRecord): LifeModelRecord {
		const record = parseLifeModelRecord(value),
			r = record.prepared.request;
		const changed = this.db
			.prepare(
				"INSERT INTO life_model_receipts(world_id,step_id,request_id,record_json,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,request_id) DO UPDATE SET record_json=excluded.record_json,digest=excluded.digest WHERE life_model_receipts.step_id=excluded.step_id",
			)
			.run(
				r.worldId,
				r.stepId,
				r.id,
				canonicalLifeJson(record),
				lifeDigest(record),
			);
		if (changed.changes !== 1)
			throw Error("LIFE model request ownership conflict");
		return record;
	}
	usage(worldId: string, config: LifeConfig): LifeUsageStatus {
		const result: LifeUsageStatus = {
			inputTokens: 0,
			outputTokens: 0,
			reservedInputTokens: 0,
			reservedOutputTokens: 0,
			unknownRequests: 0,
			upstreamAttempts: 0,
			monetaryCost: "unknown",
		};
		const now = revision(this.clock()),
			window = config.usage?.windowMs;
		for (const record of this.list(worldId)) {
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
	cancelPrepared(worldId: string, stepId: string, reason: string): void {
		for (const record of this.list(worldId, stepId)) {
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
		const row = this.db
			.prepare(
				"SELECT * FROM life_model_receipts WHERE world_id=? AND request_id=?",
			)
			.get(r.worldId, r.id) as Row | undefined;
		const prior = row ? this.decode(row) : null;
		if (prior) {
			if (lifeDigest(prior.prepared) !== lifeDigest(prepared))
				throw Error("LIFE model preparation conflict");
			return prior;
		}
		const usage = this.usage(r.worldId, config),
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
		stepId: string,
		requestId: string,
	): { record: LifeModelRecord; dispatched: boolean } {
		const record = this.get(worldId, stepId, requestId);
		if (record.status !== "prepared") return { record, dispatched: false };
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
	finish(
		worldId: string,
		stepId: string,
		requestId: string,
		value: LifeModelReconciliation,
	): LifeModelRecord {
		const record = this.get(worldId, stepId, requestId);
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
		for (const row of this.db
			.prepare("SELECT * FROM life_model_receipts")
			.iterate())
			this.decode(row as Row);
	}
}
