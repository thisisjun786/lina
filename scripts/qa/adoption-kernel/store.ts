// biome-ignore-all lint/complexity/useLiteralKeys: SQLite rows are untrusted indexed records.
import { DatabaseSync } from "node:sqlite";
import { decodeRecord } from "./records.ts";
import type {
	Adoption,
	Evidence,
	Frame,
	Purpose,
	Ref,
	ToolReceipt,
	Visibility,
} from "./types.ts";

const VERSION = 1;
const parse = <T>(text: string): T => JSON.parse(text) as T;
const key = (ref: Ref) => `${ref.id}:${ref.revision}`;

export class KernelStore {
	readonly db: DatabaseSync;
	constructor(path = ":memory:") {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS kernel_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS kernel_rows (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id,revision)) STRICT; CREATE TABLE IF NOT EXISTS kernel_effects (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS kernel_decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;",
		);
		const version = this.db
			.prepare("SELECT value FROM kernel_meta WHERE key='version'")
			.get()?.["value"];
		if (version === undefined)
			this.db
				.prepare("INSERT INTO kernel_meta VALUES ('version',?)")
				.run(String(VERSION));
		else if (version !== String(VERSION))
			throw Error("unsupported kernel schema");
	}
	close(): void {
		this.db.close();
	}
	private put(
		kind: string,
		id: string,
		revision: number,
		value: unknown,
	): void {
		this.db
			.prepare("INSERT INTO kernel_rows VALUES (?,?,?,?)")
			.run(kind, id, revision, JSON.stringify(value));
	}
	private latest<T>(kind: string, id: string): T | null {
		const row = this.db
			.prepare(
				"SELECT id,revision,data FROM kernel_rows WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1",
			)
			.get(kind, id);
		return row
			? (decodeRecord(kind, row["id"], row["revision"], row["data"]) as T)
			: null;
	}
	private rows<T>(kind: string): T[] {
		return this.db
			.prepare(
				"SELECT id,revision,data FROM kernel_rows WHERE kind=? ORDER BY id,revision",
			)
			.all(kind)
			.map(
				(row) =>
					decodeRecord(kind, row["id"], row["revision"], row["data"]) as T,
			);
	}
	observe(actor: string, evidence: Evidence): void {
		if (actor !== evidence.sourceOwner) throw Error("source owner mismatch");
		const old = this.latest<Evidence>("evidence", evidence.id);
		if (
			old &&
			(old.sourceOwner !== evidence.sourceOwner ||
				old.sourceId !== evidence.sourceId ||
				old.subject !== evidence.subject ||
				old.domain !== evidence.domain ||
				evidence.revision < old.revision)
		)
			throw Error("invalid evidence revision");
		if (old && evidence.revision === old.revision) {
			if (JSON.stringify(old) === JSON.stringify(evidence)) return;
			throw Error("conflicting evidence revision");
		}
		this.put("evidence", evidence.id, evidence.revision, evidence);
	}
	correct(actor: string, evidence: Evidence): void {
		this.observe(actor, evidence);
	}
	retract(actor: string, ref: Ref): void {
		const old = this.latest<Evidence>("evidence", ref.id);
		if (!old || old.sourceOwner !== actor || ref.revision <= old.revision)
			throw Error("invalid retraction");
		this.put("evidence", ref.id, ref.revision, {
			...old,
			revision: ref.revision,
			active: false,
		});
	}
	setPurpose(purpose: Purpose): void {
		const old = this.latest<Purpose>("purpose", purpose.id);
		if (
			old &&
			(old.subject !== purpose.subject || purpose.revision <= old.revision)
		)
			throw Error("invalid purpose revision");
		this.put("purpose", purpose.id, purpose.revision, purpose);
	}
	private eligibleEvidence(subject: string, audience: Visibility): Evidence[] {
		const latest = this.rows<Evidence>("evidence").filter(
			(item, _, all) =>
				!all.some(
					(other) => other.id === item.id && other.revision > item.revision,
				),
		);
		return latest.filter(
			(item) =>
				item.subject === subject &&
				item.active &&
				(audience === "private" || item.visibility === "public"),
		);
	}
	private eligibleAdoptions(
		subject: string,
		audience: Visibility,
		evidence: Evidence[],
	): Adoption[] {
		const currentEvidence = new Set(evidence.map((item) => key(item)));
		const allEvidence = this.rows<Evidence>("evidence");
		const candidates = this.rows<Adoption>("adoption").filter(
			(item) =>
				item.subject === subject &&
				item.status === "active" &&
				(audience === "private" || item.visibility === "public"),
		);
		const eligible = new Map<string, Adoption>();
		let changed = true;
		while (changed) {
			changed = false;
			for (const item of candidates) {
				if (eligible.has(key(item))) continue;
				if (
					item.refs.every((ref) =>
						allEvidence.some((source) => source.id === ref.id)
							? currentEvidence.has(key(ref))
							: eligible.has(key(ref)),
					)
				) {
					eligible.set(key(item), item);
					changed = true;
				}
			}
		}
		return [...eligible.values()];
	}
	frame(purposeId: string): Frame {
		const purpose = this.latest<Purpose>("purpose", purposeId);
		if (!purpose?.active) throw Error("inactive purpose");
		const evidence = this.eligibleEvidence(purpose.subject, purpose.audience);
		return {
			purpose,
			evidence,
			adoptions: this.eligibleAdoptions(
				purpose.subject,
				purpose.audience,
				evidence,
			),
			receipts: this.visibleReceipts(purpose, evidence),
			version: 1,
		};
	}
	private visibleReceipts(
		purpose: Purpose,
		evidence: Evidence[],
	): ToolReceipt[] {
		const refs = new Set(
			[
				...evidence,
				...this.eligibleAdoptions(purpose.subject, purpose.audience, evidence),
			].map(key),
		);
		return this.db
			.prepare(
				"SELECT data FROM kernel_effects WHERE json_extract(data,'$.receipt') IS NOT NULL",
			)
			.all()
			.flatMap((row) => {
				const effect = parse<{ receipt: ToolReceipt; sourceFrame?: Frame }>(
					String(row["data"]),
				);
				const frame = effect.sourceFrame;
				if (!frame || frame.purpose.subject !== purpose.subject) return [];
				if (
					purpose.audience === "public" &&
					(frame.purpose.audience === "private" ||
						[...frame.evidence, ...frame.adoptions].some(
							(x) => x.visibility === "private",
						))
				)
					return [];
				if (
					[...frame.evidence, ...frame.adoptions].some((x) => !refs.has(key(x)))
				)
					return [];
				return [effect.receipt];
			});
	}

	prepare(purposeId: string, decisionId: string): Frame {
		const frame = this.frame(purposeId);
		this.db
			.prepare("INSERT INTO kernel_decisions VALUES (?,?)")
			.run(
				decisionId,
				JSON.stringify({ purposeId, frame, status: "prepared" }),
			);
		return frame;
	}
	current(frame: Frame): boolean {
		try {
			return (
				JSON.stringify(this.frame(frame.purpose.id)) === JSON.stringify(frame)
			);
		} catch {
			return false;
		}
	}
	adopt(decisionId: string, adoption: Adoption): void {
		this.put("adoption", adoption.id, adoption.revision, adoption);
		this.db
			.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
			.run(JSON.stringify({ status: "adopted", adoption }), decisionId);
	}
	defer(decisionId: string, condition: string, reason: string): void {
		const row = this.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(decisionId);
		if (!row) throw Error("unknown decision");
		this.db.prepare("UPDATE kernel_decisions SET data=? WHERE id=?").run(
			JSON.stringify({
				...parse<Record<string, unknown>>(String(row["data"])),
				status: "deferred",
				condition,
				reason,
				signaled: false,
			}),
			decisionId,
		);
	}
	private decisionFrame(id: string): Frame {
		const row = this.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(id);
		if (!row) throw Error("unknown decision");
		const data = parse<{ frame?: Frame }>(String(row["data"]));
		if (!data.frame) throw Error("missing decision frame");
		return data.frame;
	}

	dispatch(
		effectId: string,
		tool: string,
		args: unknown,
		fence: string,
	): boolean {
		const row = this.db
			.prepare("SELECT id FROM kernel_effects WHERE id=?")
			.get(effectId);
		if (row) return false;
		this.db.prepare("INSERT INTO kernel_effects VALUES (?,?)").run(
			effectId,
			JSON.stringify({
				effectId,
				tool,
				args,
				fence,
				status: "dispatched",
				sourceFrame: this.decisionFrame(fence),
			}),
		);
		return true;
	}
	recordResult(receipt: ToolReceipt): void {
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(receipt.effectId);
		if (!row) throw Error("unknown effect");
		this.db.prepare("UPDATE kernel_effects SET data=? WHERE id=?").run(
			JSON.stringify({
				...parse<Record<string, unknown>>(String(row["data"])),
				receipt,
				status: receipt.status,
			}),
			receipt.effectId,
		);
	}
	pending(): string[] {
		return this.db
			.prepare(
				"SELECT id FROM kernel_effects WHERE json_extract(data,'$.status')='dispatched'",
			)
			.all()
			.map((row) => String(row["id"]));
	}
	signal(condition: string): void {
		for (const row of this.db
			.prepare("SELECT id,data FROM kernel_decisions")
			.all()) {
			const data = parse<Record<string, unknown>>(String(row["data"]));
			if (data["status"] === "deferred" && data["condition"] === condition)
				this.db
					.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
					.run(JSON.stringify({ ...data, signaled: true }), String(row["id"]));
		}
	}
	deferred(): string[] {
		return this.db
			.prepare("SELECT id,data FROM kernel_decisions")
			.all()
			.filter((row) => {
				const data = parse<Record<string, unknown>>(String(row["data"]));
				return data["status"] === "deferred" && data["signaled"] !== true;
			})
			.map((row) => String(row["id"]));
	}
	consume(effectId: string): ToolReceipt | null {
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(effectId);
		return row
			? (parse<{ receipt?: ToolReceipt }>(String(row["data"])).receipt ?? null)
			: null;
	}
}
