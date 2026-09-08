import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	parseSourcePolicy,
	type SourcePolicy,
	sourcePolicyDigest,
} from "./source-policy.ts";
import {
	parseSourceExposure,
	parseSourceOrigin,
	type SourceExposure,
	type SourceRequestOrigin,
	sourcePolicyFor,
} from "./source-policy-origin.ts";

function invalid(): never {
	throw Error("Invalid or conflicting journal source");
}
/** All writes are inside the DurableStore transaction, including entry append. */
export class SourcePolicyStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sessionId: string,
	) {}

	exposure(value: SourceExposure): boolean {
		const receipt = parseSourceExposure(value);
		const saved = this.receipt(receipt.id);
		if (saved) {
			if (
				!isDeepStrictEqual(
					{ ...saved, outcome: "planned" },
					{ ...receipt, outcome: "planned" },
				)
			)
				invalid();
			if (saved.outcome === "delivered" || receipt.outcome === "planned")
				return false;
			this.db
				.prepare("UPDATE source_exposures SET receipt_json=? WHERE id=?")
				.run(JSON.stringify(receipt), receipt.id);
			return true;
		}
		if (receipt.outcome !== "planned") invalid();
		this.db
			.prepare("INSERT INTO source_exposures VALUES (?,?)")
			.run(receipt.id, JSON.stringify(receipt));
		return true;
	}
	register(value: SourceRequestOrigin): boolean {
		const origin = parseSourceOrigin(value);
		if (origin.sessionId !== this.sessionId) invalid();
		const request = this.db
			.prepare("SELECT session_id FROM requests WHERE id=?")
			.get(origin.requestId);
		if (request?.["session_id"] !== this.sessionId) invalid();
		const previous = this.origin(origin.requestId);
		if (previous) {
			if (!isDeepStrictEqual(previous, origin)) invalid();
			return false;
		}
		const policy = this.derive(origin, 1);
		this.db
			.prepare("INSERT INTO source_requests VALUES (?,?)")
			.run(origin.requestId, JSON.stringify(origin));
		this.save(policy);
		return true;
	}
	extend(requestId: string, receiptIds: readonly string[]): boolean {
		const origin = this.origin(requestId),
			previous = this.policy(requestId);
		if (!origin || !previous) invalid();
		const next = parseSourceOrigin({
			...origin,
			contextReceiptIds: [
				...new Set([...previous.contextReceiptIds, ...receiptIds]),
			],
		});
		if (isDeepStrictEqual(next.contextReceiptIds, previous.contextReceiptIds))
			return false;
		this.save(this.derive(next, previous.policyRevision + 1));
		return true;
	}
	associate(entryId: string, requestId: string): boolean {
		if (!this.policy(requestId)) invalid();
		const saved = this.db
			.prepare("SELECT request_id FROM source_entries WHERE entry_id=?")
			.get(entryId)?.["request_id"];
		if (saved !== undefined) {
			if (saved !== requestId) invalid();
			return false;
		}
		this.db
			.prepare("INSERT INTO source_entries VALUES (?,?)")
			.run(entryId, requestId);
		return true;
	}
	entryRequest(entryId: string): string | undefined {
		const value = this.db
			.prepare("SELECT request_id FROM source_entries WHERE entry_id=?")
			.get(entryId)?.["request_id"];
		return typeof value === "string" ? value : undefined;
	}
	policy(requestId: string): SourcePolicy | undefined {
		const row = this.db
			.prepare(`SELECT p.policy_json,p.policy_digest FROM source_current c
			JOIN source_policies p ON p.request_id=c.request_id AND p.policy_revision=c.policy_revision WHERE c.request_id=?`)
			.get(requestId);
		if (!row) return;
		const policy = parseSourcePolicy(JSON.parse(String(row["policy_json"])));
		if (
			policy.requestId !== requestId ||
			sourcePolicyDigest(policy) !== row["policy_digest"]
		)
			invalid();
		return policy;
	}
	validate(): void {
		if (this.db.prepare("PRAGMA foreign_key_check").all().length) invalid();
		for (const row of this.db
			.prepare("SELECT id,receipt_json FROM source_exposures")
			.all()) {
			const receipt = parseSourceExposure(
				JSON.parse(String(row["receipt_json"])),
			);
			if (receipt.id !== row["id"]) invalid();
		}
		for (const row of this.db
			.prepare("SELECT request_id,origin_json FROM source_requests")
			.all()) {
			const origin = parseSourceOrigin(JSON.parse(String(row["origin_json"])));
			if (
				origin.requestId !== row["request_id"] ||
				origin.sessionId !== this.sessionId
			)
				invalid();
			const request = this.db
				.prepare("SELECT session_id FROM requests WHERE id=?")
				.get(origin.requestId);
			if (request?.["session_id"] !== this.sessionId) invalid();
			const policies = this.db
				.prepare(
					"SELECT * FROM source_policies WHERE request_id=? ORDER BY policy_revision",
				)
				.all(origin.requestId);
			let previous: SourcePolicy | undefined;
			for (let index = 0; index < policies.length; index++) {
				const row = policies[index];
				if (!row) invalid();
				const policy = parseSourcePolicy(
					JSON.parse(String(row["policy_json"])),
				);
				if (
					row["policy_revision"] !== index + 1 ||
					policy.policyRevision !== index + 1 ||
					row["policy_digest"] !== sourcePolicyDigest(policy)
				)
					invalid();
				const expected = this.derive(
					{ ...origin, contextReceiptIds: policy.contextReceiptIds },
					index + 1,
				);
				if (!isDeepStrictEqual(policy, expected)) invalid();
				if (
					previous
						? previous.contextReceiptIds.some(
								(id) => !policy.contextReceiptIds.includes(id),
							) ||
							previous.contextReceiptIds.length ===
								policy.contextReceiptIds.length
						: !isDeepStrictEqual(
								policy.contextReceiptIds,
								origin.contextReceiptIds,
							)
				)
					invalid();
				previous = policy;
			}
			if (
				!previous ||
				!isDeepStrictEqual(previous, this.policy(origin.requestId))
			)
				invalid();
		}
		for (const row of this.db
			.prepare(`SELECT s.entry_id,s.request_id,e.session_id,r.entry_id AS user_id,e.role FROM source_entries s
			JOIN entries e ON e.entry_id=s.entry_id JOIN requests r ON r.id=s.request_id`)
			.all()) {
			if (
				row["session_id"] !== this.sessionId ||
				(row["role"] === "user" &&
					row["user_id"] !== null &&
					row["user_id"] !== row["entry_id"])
			)
				invalid();
		}
	}
	private origin(requestId: string): SourceRequestOrigin | undefined {
		const row = this.db
			.prepare("SELECT origin_json FROM source_requests WHERE request_id=?")
			.get(requestId);
		return row
			? parseSourceOrigin(JSON.parse(String(row["origin_json"])))
			: undefined;
	}
	private receipt(id: string): SourceExposure | undefined {
		const row = this.db
			.prepare("SELECT receipt_json FROM source_exposures WHERE id=?")
			.get(id);
		return row
			? parseSourceExposure(JSON.parse(String(row["receipt_json"])))
			: undefined;
	}
	private derive(origin: SourceRequestOrigin, revision: number): SourcePolicy {
		const receipts = origin.contextReceiptIds.map((id) => {
			const receipt = this.receipt(id);
			if (!receipt) invalid();
			return receipt;
		});
		return sourcePolicyFor(origin, receipts, revision);
	}
	private save(policy: SourcePolicy): void {
		this.db
			.prepare("INSERT INTO source_policies VALUES (?,?,?,?)")
			.run(
				policy.requestId,
				policy.policyRevision,
				JSON.stringify(policy),
				sourcePolicyDigest(policy),
			);
		this.db
			.prepare(
				"INSERT INTO source_current VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET policy_revision=excluded.policy_revision",
			)
			.run(policy.requestId, policy.policyRevision);
	}
}
