import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { boundedId } from "./validation.ts";
import type {
	AvatarCapacityInput,
	AvatarCapacityReceipt,
	AvatarCapacityUsage,
	AvatarInventoryFile,
} from "./visual.ts";
import { requireVisualHistorySpace } from "./visual-history-capacity.ts";
import {
	exact,
	hash,
	integer,
	MAX_AVATAR_BYTES,
	MAX_AVATAR_FILES,
	MAX_AVATAR_TOTAL_BYTES,
	parseAvatarAsset,
	requireVisualRecord,
	visualDigest,
} from "./visual-validation.ts";

export {
	MAX_AVATAR_BYTES,
	MAX_AVATAR_FILES,
	MAX_AVATAR_TOTAL_BYTES,
} from "./visual-validation.ts";

function parseFile(value: unknown): AvatarInventoryFile {
	const v = exact(value, "fileId,sha256,mime,size");
	return {
		fileId: boundedId(v["fileId"], "avatar inventory file"),
		...parseAvatarAsset({
			sha256: v["sha256"],
			mime: v["mime"],
			size: v["size"],
		}),
	};
}
function parseInput(value: unknown): AvatarCapacityInput {
	const v = exact(value, "reservationId,owner,maxBytes"),
		raw = v["owner"] as AvatarCapacityInput["owner"];
	let owner: AvatarCapacityInput["owner"];
	if (raw?.kind === "manual") {
		const o = exact(raw, "kind,agentId,requestKey");
		owner = {
			kind: "manual",
			agentId: boundedId(o["agentId"], "agent"),
			requestKey: boundedId(o["requestKey"], "request key"),
		};
	} else {
		const o = exact(raw, "kind,agentId,worldId,intentId,attemptId");
		if (o["kind"] !== "generated") throw Error("invalid avatar capacity owner");
		owner = {
			kind: "generated",
			agentId: boundedId(o["agentId"], "agent"),
			worldId: boundedId(o["worldId"], "world"),
			intentId: boundedId(o["intentId"], "intent"),
			attemptId: boundedId(o["attemptId"], "attempt"),
		};
	}
	return {
		reservationId: boundedId(v["reservationId"], "reservation"),
		owner,
		maxBytes: integer(v["maxBytes"], 1, MAX_AVATAR_BYTES),
	};
}
/** All mutations run inside AgentStore's shared BEGIN IMMEDIATE transaction. */
export class VisualCapacity {
	constructor(private readonly db: DatabaseSync) {}
	usage(): AvatarCapacityUsage {
		const a = requireVisualRecord(
			this.db
				.prepare(
					"SELECT COUNT(*) n,COALESCE(SUM(size),0) bytes FROM agent_avatar_capacity_assets",
				)
				.get(),
		);
		const rows = this.db
			.prepare(
				"SELECT input_json FROM agent_avatar_capacity_reservations WHERE state='reserved'",
			)
			.all();
		return {
			files: Number(a["n"]),
			bytes: Number(a["bytes"]),
			reservedFiles: rows.length,
			reservedBytes: rows.reduce(
				(sum, r) =>
					sum + parseInput(JSON.parse(String(r["input_json"]))).maxBytes,
				0,
			),
		};
	}
	sync(value: AvatarInventoryFile[]): AvatarCapacityUsage {
		if (!Array.isArray(value)) throw Error("invalid avatar inventory");
		const files = value.map(parseFile);
		if (new Set(files.map((f) => f.fileId)).size !== files.length)
			throw Error("duplicate avatar inventory file");
		// Monotonic inventory: a partial scan can never refund retained bytes.
		for (const file of files) this.addFile(file);
		this.db
			.prepare("INSERT OR IGNORE INTO agent_avatar_capacity_state VALUES(1,1)")
			.run();
		// An orphan can coexist with its outstanding reservation until UUID/hash adoption.
		// Real inventory is recorded even when externally-created files exceed the ceiling.
		return this.usage();
	}
	reserve(value: AvatarCapacityInput): AvatarCapacityReceipt {
		const input = parseInput(value),
			old = this.get(input.reservationId);
		if (old) {
			const { version: _v, state: _s, asset: _a, ...previous } = old;
			if (visualDigest(previous) !== visualDigest(input))
				throw Error("avatar reservation conflict");
			return old;
		}
		this.assertAvailable(input);
		this.db
			.prepare(
				"INSERT INTO agent_avatar_capacity_reservations VALUES(?,?,?,'reserved',NULL)",
			)
			.run(input.reservationId, JSON.stringify(input), visualDigest(input));
		return { ...input, version: 1, state: "reserved", asset: null };
	}
	/** Explicit destination retry; ordinary reserve replay never reopens a released hold. */
	reacquire(id: string): AvatarCapacityReceipt {
		const old = this.get(id);
		if (!old || old.owner.kind !== "generated")
			throw Error("generated avatar reservation required");
		if (old.state !== "released") return old;
		this.assertAvailable(old, 0);
		const changed = this.db
			.prepare(
				"UPDATE agent_avatar_capacity_reservations SET state='reserved' WHERE reservation_id=? AND state='released'",
			)
			.run(id);
		if (changed.changes !== 1) throw Error("avatar reservation conflict");
		return { ...old, state: "reserved" };
	}
	private assertAvailable(
		input: AvatarCapacityInput,
		addedHistoryRows = 1,
	): void {
		if (
			!this.db
				.prepare("SELECT 1 FROM agent_profiles WHERE id=?")
				.get(input.owner.agentId)
		)
			throw Error("agent not found");
		if (
			!this.db
				.prepare("SELECT 1 FROM agent_avatar_capacity_state WHERE id=1")
				.get()
		)
			throw Error("avatar capacity inventory not configured");
		const u = this.usage();
		if (
			u.files + u.reservedFiles + 1 > MAX_AVATAR_FILES ||
			u.bytes + u.reservedBytes + input.maxBytes > MAX_AVATAR_TOTAL_BYTES
		)
			throw Error("avatar capacity reached");
		if (input.owner.kind === "generated")
			requireVisualHistorySpace(this.db, input.owner.agentId, addedHistoryRows);
	}
	get(id: string): AvatarCapacityReceipt | undefined {
		boundedId(id, "reservation");
		const row = this.db
			.prepare(
				"SELECT input_json,payload_digest,state,asset_json FROM agent_avatar_capacity_reservations WHERE reservation_id=?",
			)
			.get(id);
		if (!row) return undefined;
		const input = parseInput(JSON.parse(String(row["input_json"])));
		if (
			input.reservationId !== id ||
			visualDigest(input) !== row["payload_digest"]
		)
			throw Error("corrupt avatar reservation");
		const state = row["state"];
		if (state !== "reserved" && state !== "released" && state !== "settled")
			throw Error("invalid avatar reservation state");
		const asset =
			row["asset_json"] === null
				? null
				: parseFile(JSON.parse(String(row["asset_json"])));
		if (
			(state === "settled") !== (asset !== null) ||
			(asset && asset.size > input.maxBytes)
		)
			throw Error("invalid avatar reservation settlement");
		return { ...input, version: 1, state, asset };
	}
	settle(id: string, value: AvatarInventoryFile): AvatarCapacityReceipt {
		const asset = parseFile(value),
			old = this.get(id);
		if (!old) throw Error("avatar reservation not found");
		if (old.state === "settled") {
			if (!isDeepStrictEqual(old.asset, asset))
				throw Error("avatar settlement conflict");
			return old;
		}
		if (old.state !== "reserved" || asset.size > old.maxBytes)
			throw Error("avatar settlement conflict");
		this.addFile(asset);
		this.db
			.prepare(
				"UPDATE agent_avatar_capacity_reservations SET state='settled',asset_json=? WHERE reservation_id=?",
			)
			.run(JSON.stringify(asset), id);
		return { ...old, state: "settled", asset };
	}
	release(id: string): AvatarCapacityReceipt {
		const old = this.get(id);
		if (!old) throw Error("avatar reservation not found");
		if (old.state !== "reserved") return old;
		this.db
			.prepare(
				"UPDATE agent_avatar_capacity_reservations SET state='released' WHERE reservation_id=?",
			)
			.run(id);
		return { ...old, state: "released" };
	}
	has(asset: unknown): boolean {
		const a = parseAvatarAsset(asset);
		return Boolean(
			this.db
				.prepare(
					"SELECT 1 FROM agent_avatar_capacity_assets WHERE sha256=? AND mime=? AND size=?",
				)
				.get(a.sha256, a.mime, a.size),
		);
	}
	audit(): void {
		for (const r of this.db
			.prepare(
				"SELECT file_id,sha256,mime,size FROM agent_avatar_capacity_assets",
			)
			.iterate())
			parseFile({
				fileId: r["file_id"],
				sha256: r["sha256"],
				mime: r["mime"],
				size: r["size"],
			});
		for (const r of this.db
			.prepare("SELECT reservation_id FROM agent_avatar_capacity_reservations")
			.iterate()) {
			const receipt = requireVisualRecord(
				this.get(String(r["reservation_id"])),
			);
			if (
				!this.db
					.prepare("SELECT 1 FROM agent_profiles WHERE id=?")
					.get(receipt.owner.agentId)
			)
				throw Error("orphan avatar reservation");
			if (receipt.asset) {
				const a = this.file(receipt.asset.fileId);
				if (!isDeepStrictEqual(a, receipt.asset))
					throw Error("missing settled avatar asset");
			}
		}
	}
	private file(id: string): AvatarInventoryFile | undefined {
		const r = this.db
			.prepare(
				"SELECT file_id,sha256,mime,size FROM agent_avatar_capacity_assets WHERE file_id=?",
			)
			.get(id);
		return r
			? parseFile({
					fileId: r["file_id"],
					sha256: r["sha256"],
					mime: r["mime"],
					size: r["size"],
				})
			: undefined;
	}
	private addFile(file: AvatarInventoryFile): void {
		hash(file.sha256);
		const old = this.file(file.fileId);
		if (old) {
			if (!isDeepStrictEqual(old, file))
				throw Error("avatar inventory conflict");
			return;
		}
		const same = this.db
			.prepare(
				"SELECT mime,size FROM agent_avatar_capacity_assets WHERE sha256=?",
			)
			.all(file.sha256);
		if (same.some((r) => r["mime"] !== file.mime || r["size"] !== file.size))
			throw Error("avatar hash metadata conflict");
		this.db
			.prepare("INSERT INTO agent_avatar_capacity_assets VALUES(?,?,?,?)")
			.run(file.fileId, file.sha256, file.mime, file.size);
	}
}
