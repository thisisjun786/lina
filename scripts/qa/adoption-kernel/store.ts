// biome-ignore-all lint/complexity/useLiteralKeys: SQLite rows are untrusted indexed records.
import { DatabaseSync } from "node:sqlite";
import { decodeEffect } from "./effect-records.ts";
import { decodeDecision, decodeFrame, decodeRecord } from "./records.ts";
import type {
	Adoption,
	Evidence,
	Frame,
	Purpose,
	Ref,
	ToolReceipt,
	Visibility,
} from "./types.ts";
import { parseJudgment, parseReceipt } from "./validation.ts";

const VERSION = 1;
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
		const data = JSON.stringify(value);
		decodeRecord(kind, id, revision, data);
		this.db
			.prepare("INSERT INTO kernel_rows VALUES (?,?,?,?)")
			.run(kind, id, revision, data);
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
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.observeSource(actor, evidence);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private observeSource(actor: string, input: Evidence): void {
		let evidence = input;
		if (actor !== evidence.sourceOwner) throw Error("source owner mismatch");
		const named = this.latest<Evidence>("evidence", evidence.id);
		if (
			named &&
			(named.sourceOwner !== actor || named.sourceId !== evidence.sourceId)
		)
			throw Error("source identity mismatch");
		const source = this.db
			.prepare(
				"SELECT id FROM kernel_rows WHERE kind='evidence' AND json_extract(data,'$.sourceOwner')=? AND json_extract(data,'$.sourceId')=? ORDER BY revision DESC LIMIT 1",
			)
			.get(actor, evidence.sourceId);
		if (source) evidence = { ...evidence, id: String(source["id"]) };
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
		const candidates = new Map(latest.map((item) => [item.id, item]));
		const allowed = new Set<string>();
		const visiting = new Set<string>();
		const eligible = (item: Evidence): boolean => {
			if (allowed.has(item.id)) return true;
			if (
				visiting.has(item.id) ||
				item.subject !== subject ||
				!item.active ||
				(audience === "public" && item.visibility !== "public")
			)
				return false;
			visiting.add(item.id);
			const valid = item.parents.every((ref) => {
				const parent = candidates.get(ref.id);
				return (
					parent !== undefined &&
					parent.revision === ref.revision &&
					eligible(parent)
				);
			});
			visiting.delete(item.id);
			if (valid) allowed.add(item.id);
			return valid;
		};
		return latest.filter(eligible);
	}

	private eligibleAdoptions(
		subject: string,
		audience: Visibility,
		evidence: Evidence[],
	): Adoption[] {
		const currentEvidence = new Set(evidence.map((item) => key(item)));
		const allEvidence = this.rows<Evidence>("evidence");
		const candidates = this.rows<Adoption>("adoption").filter(
			(item, _, all) =>
				!all.some(
					(other) => other.id === item.id && other.revision > item.revision,
				) &&
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
				const source = this.decisionFrame(item.sourceDecisionId);
				if (source.purpose.subject !== item.subject)
					throw Error("adoption source subject mismatch");
				const dependencies = [
					...item.refs,
					...source.evidence,
					...source.adoptions,
				];
				if (
					dependencies.every((ref) =>
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
				"SELECT id,data FROM kernel_effects WHERE json_extract(data,'$.receipt') IS NOT NULL",
			)
			.all()
			.flatMap((row) => {
				const effect = this.effect(row["id"], row["data"]);
				if (!effect.receipt) throw Error("missing stored receipt");
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
				return [parseReceipt(effect.receipt)];
			});
	}

	prepare(purposeId: string, decisionId: string): Frame {
		const frame = this.frame(purposeId);
		this.db.prepare("INSERT INTO kernel_decisions VALUES (?,?)").run(
			decisionId,
			JSON.stringify({
				purposeId,
				frame,
				status: "prepared",
				method: null,
				expectation: { kind: "none" },
				policyVersion: frame.purpose.policyVersion,
			}),
		);
		return frame;
	}
	recordJudgment(id: string, input: import("./types.ts").Judgment): void {
		const judgment = parseJudgment(input);
		const row = this.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(id);
		if (!row) throw Error("unknown decision");
		const data = decodeDecision(row["data"]);
		if (
			data["status"] !== "prepared" ||
			data["judgmentRecorded"] ||
			!this.current(decodeFrame(data["frame"]))
		)
			throw Error("judgment is already fixed or stale");
		this.db
			.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
			.run(
				JSON.stringify({ ...data, ...judgment, judgmentRecorded: true }),
				id,
			);
	}

	admitCurrent(frame: Frame, admit: () => void): boolean {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!this.current(frame)) {
				this.db.exec("ROLLBACK");
				return false;
			}
			admit();
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
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
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db
				.prepare("SELECT data FROM kernel_decisions WHERE id=?")
				.get(decisionId);
			if (!row) throw Error("unknown decision");
			const original = decodeDecision(row["data"]);
			if (
				original["status"] !== "prepared" ||
				!this.current(decodeFrame(original["frame"]))
			)
				throw Error("stale adoption decision");
			this.put("adoption", adoption.id, adoption.revision, adoption);
			this.db
				.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
				.run(
					JSON.stringify({ ...original, status: "adopted", adoption }),
					decisionId,
				);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	defer(decisionId: string, condition: string, reason: string): void {
		const row = this.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(decisionId);
		if (!row) throw Error("unknown decision");
		this.db.prepare("UPDATE kernel_decisions SET data=? WHERE id=?").run(
			JSON.stringify({
				...decodeDecision(row["data"]),
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
		const data = decodeDecision(row["data"]);
		return decodeFrame(data["frame"]);
	}

	private effect(
		id: unknown,
		data: unknown,
	): import("./effect-records.ts").EffectRecord {
		const effect = decodeEffect(id, data);
		if (
			JSON.stringify(effect.sourceFrame) !==
			JSON.stringify(this.decisionFrame(effect.fence))
		)
			throw Error("effect source snapshot mismatch");
		return effect;
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
	recordResult(input: ToolReceipt): void {
		const receipt = parseReceipt(input);
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(receipt.effectId);
		if (!row) throw Error("unknown effect");
		const original = this.effect(receipt.effectId, row["data"]);
		if (original.receipt && original.receipt.status !== "unknown") {
			if (JSON.stringify(original.receipt) !== JSON.stringify(receipt))
				throw Error("conflicting terminal receipt");
			return;
		}
		this.db.prepare("UPDATE kernel_effects SET data=? WHERE id=?").run(
			JSON.stringify({
				...original,
				receipt,
				status: receipt.status,
			}),
			receipt.effectId,
		);
	}
	cancelUnadmitted(effectId: string): void {
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(effectId);
		if (!row) throw Error("unknown effect");
		const effect = this.effect(effectId, row["data"]);
		if (effect.status !== "dispatched" || effect.receipt)
			throw Error("effect cannot be cancelled");
		this.db
			.prepare("UPDATE kernel_effects SET data=? WHERE id=?")
			.run(JSON.stringify({ ...effect, status: "cancelled" }), effectId);
	}
	pendingEffect(
		effectId: string,
	): { tool: string; decisionId: string; cancelled: boolean } | null {
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(effectId);
		if (!row) return null;
		const data = this.effect(effectId, row["data"]);
		return {
			tool: data.tool,
			decisionId: data.fence,
			cancelled: data.status === "cancelled",
		};
	}

	pending(): string[] {
		return this.db
			.prepare(
				"SELECT e.id,e.data,d.data AS decision FROM kernel_effects e LEFT JOIN kernel_decisions d ON d.id=json_extract(e.data,'$.fence')",
			)
			.all()
			.filter((row) => {
				const effect = this.effect(row["id"], row["data"]);
				const decision = decodeDecision(row["decision"]);
				return (
					effect.status === "dispatched" ||
					effect.status === "unknown" ||
					decision["status"] === "prepared" ||
					decision["status"] === "unknown"
				);
			})
			.map((row) => String(row["id"]));
	}
	signal(condition: string): void {
		for (const row of this.db
			.prepare("SELECT id,data FROM kernel_decisions")
			.all()) {
			const data = decodeDecision(row["data"]);
			if (data["status"] === "deferred" && data["condition"] === condition)
				this.db
					.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
					.run(JSON.stringify({ ...data, signaled: true }), String(row["id"]));
		}
	}
	readyDeferred(): { id: string; purposeId: string }[] {
		return this.db
			.prepare(
				"SELECT id,data FROM kernel_decisions WHERE json_extract(data,'$.status')='deferred' AND json_extract(data,'$.signaled')=1",
			)
			.all()
			.map((row) => {
				const data = decodeDecision(row["data"]);
				if (typeof data["purposeId"] !== "string")
					throw Error("invalid deferred purpose");
				return { id: String(row["id"]), purposeId: data["purposeId"] };
			});
	}
	completeDeferred(id: string, nextDecisionId: string): void {
		const row = this.db
			.prepare("SELECT data FROM kernel_decisions WHERE id=?")
			.get(id);
		if (!row) throw Error("missing deferred decision");
		const data = decodeDecision(row["data"]);
		if (
			data["status"] === "resumed" &&
			data["nextDecisionId"] === nextDecisionId
		)
			return;
		if (data["status"] !== "deferred" || data["signaled"] !== true)
			throw Error("deferred decision not ready");
		this.db
			.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
			.run(JSON.stringify({ ...data, status: "resumed", nextDecisionId }), id);
	}

	deferred(): string[] {
		return this.db
			.prepare("SELECT id,data FROM kernel_decisions")
			.all()
			.filter((row) => {
				const data = decodeDecision(row["data"]);
				return data["status"] === "deferred" && data["signaled"] !== true;
			})
			.map((row) => String(row["id"]));
	}
	consume(effectId: string): ToolReceipt | null {
		const row = this.db
			.prepare("SELECT data FROM kernel_effects WHERE id=?")
			.get(effectId);
		if (!row) return null;
		return this.effect(effectId, row["data"]).receipt ?? null;
	}
}
