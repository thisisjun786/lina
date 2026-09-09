import { DatabaseSync } from "node:sqlite";
import type { ToolReceipt, Visibility } from "./types.ts";

/** Synthetic delivery owner: its durable receipt is independent of kernel state. */
export class DeliveryOwner {
	private readonly db: DatabaseSync;
	constructor(path = ":memory:") {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS delivery_receipts (id TEXT PRIMARY KEY, bytes TEXT NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('private','public')), fence TEXT NOT NULL) STRICT",
		);
	}
	admit(
		effectId: string,
		bytes: string,
		audience: Visibility,
		fence: string,
	): void {
		this.db
			.prepare("INSERT OR IGNORE INTO delivery_receipts VALUES (?,?,?,?)")
			.run(effectId, bytes, audience, fence);
		const stored = this.read(effectId);
		if (
			!stored ||
			JSON.stringify(stored.output) !==
				JSON.stringify({ bytes, audience, fence })
		)
			throw Error("conflicting delivery replay");
	}
	private read(effectId: string): ToolReceipt | null {
		const row = this.db
			.prepare("SELECT bytes,audience,fence FROM delivery_receipts WHERE id=?")
			.get(effectId);
		if (!row) return null;
		const { bytes, audience, fence } = row;
		if (
			typeof bytes !== "string" ||
			typeof fence !== "string" ||
			(audience !== "private" && audience !== "public")
		)
			throw Error("invalid delivery receipt");
		return {
			effectId,
			status: "completed",
			output: { bytes, audience, fence },
			quality: {
				status: "unverified",
				verifier: null,
				detail: "delivery recorded",
			},
		};
	}
	async reconcile(effectId: string): Promise<ToolReceipt | null> {
		return this.read(effectId);
	}
	close(): void {
		this.db.close();
	}
}
export type { DeliveryPort } from "./types.ts";
