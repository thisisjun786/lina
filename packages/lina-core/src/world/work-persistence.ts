import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { LifeConfig } from "./authoring-types.ts";
import type { LifeStep } from "./autonomy-types.ts";
import { canonicalLifeJson, lifeDigest, revision } from "./life-json.ts";
import type { AdmissionReceipt, LifeInput, LifeInputV2 } from "./life-types.ts";
import { parseLifeInput } from "./life-validation.ts";
import {
	parseWorkAncestry,
	stepWorkAncestry,
	workSubjectAllowed,
} from "./work-ancestry.ts";
import { workExperiences } from "./work-experience.ts";
import type {
	WorkAncestryRecord,
	WorkEvidenceSnapshot,
	WorkSubject,
} from "./work-types.ts";

type Access = {
	assertWorld(worldId: string): void;
	config(worldId: string): LifeConfig;
	configAt(worldId: string, revision: number): LifeConfig;
	inputs(worldId: string): LifeInput[];
	admit(input: LifeInputV2): AdmissionReceipt;
};
type WorkHistoryEvent =
	| { kind: "input"; inputId: string }
	| { kind: "configuration"; configRevision: number; workConfigDigest: string };
type Row = {
	revision: number;
	input_id: string | null;
	event_json: string;
	previous_digest: string;
	next_digest: string;
};
function workDigest(config: LifeConfig): string {
	return lifeDigest(config.version === 2 ? config.work : null);
}
function empty(worldId: string): WorkEvidenceSnapshot {
	return {
		version: 1,
		worldId,
		revision: 0,
		permissionRevision: 0,
		workConfigDigest: lifeDigest(null),
		records: [],
	};
}
function invalid(): never {
	throw Error("Corrupt or conflicting work evidence");
}

/** WorldStore owns each surrounding transaction. No external task or model call occurs here. */
export class WorkPersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: Access,
	) {}
	snapshot(worldId: string, at?: number): WorkEvidenceSnapshot {
		if (at !== undefined) revision(at);
		this.access.assertWorld(worldId);
		const rows = this.db
			.prepare(
				"SELECT revision,input_id,event_json,previous_digest,next_digest FROM life_work_history WHERE world_id=? ORDER BY revision",
			)
			.all(worldId) as unknown as Row[];
		const inputs = new Map(
			this.access.inputs(worldId).map((input) => [input.id, input]),
		);
		let state = empty(worldId);
		let historical = at === 0 ? state : undefined;
		for (const row of rows) {
			if (
				revision(row.revision, 1) !== state.revision + 1 ||
				row.previous_digest !== lifeDigest(state)
			)
				invalid();
			const event = JSON.parse(row.event_json) as WorkHistoryEvent;
			if (!event || typeof event !== "object" || Array.isArray(event))
				invalid();
			if (event.kind === "input") {
				if (Object.keys(event).length !== 2 || event.inputId !== row.input_id)
					invalid();
				const input = inputs.get(event.inputId);
				if (!input || input.version !== 2) invalid();
				state = this.applyInput(state, input);
			} else if (event.kind === "configuration") {
				if (Object.keys(event).length !== 3 || row.input_id !== null) invalid();
				const config = this.access.configAt(
					worldId,
					revision(event.configRevision, 1),
				);
				if (
					workDigest(config) !== event.workConfigDigest ||
					state.workConfigDigest === event.workConfigDigest
				)
					invalid();
				state = {
					...state,
					revision: state.revision + 1,
					permissionRevision: revision(state.permissionRevision + 1),
					workConfigDigest: event.workConfigDigest,
				};
			} else invalid();
			if (row.next_digest !== lifeDigest(state)) invalid();
			if (state.revision === at) historical = state;
		}
		const saved = this.db
			.prepare("SELECT state_json,digest FROM life_work_state WHERE world_id=?")
			.get(worldId);
		if (
			saved
				? !isDeepStrictEqual(JSON.parse(String(saved["state_json"])), state) ||
					saved["digest"] !== lifeDigest(state)
				: state.revision !== 0
		)
			invalid();
		if (at !== undefined && !historical) invalid();
		return historical ?? state;
	}

	inputsAt(
		worldId: string,
		workRevision: number,
		lifeRevision: number,
	): LifeInput[] {
		this.snapshot(worldId, workRevision);
		revision(lifeRevision);
		const ids = new Set(
			this.db
				.prepare(
					"SELECT input_id FROM life_work_history WHERE world_id=? AND revision<=? AND input_id IS NOT NULL",
				)
				.all(worldId, workRevision)
				.map((r) => r["input_id"]),
		);
		return this.access
			.inputs(worldId)
			.filter((input) => ids.has(input.id))
			.map((input) => ({
				...input,
				consumedLifeRevision:
					input.consumedLifeRevision !== null &&
					input.consumedLifeRevision <= lifeRevision
						? input.consumedLifeRevision
						: null,
			}));
	}
	ancestry(
		worldId: string,
		atLifeRevision = Number.MAX_SAFE_INTEGER,
	): WorkAncestryRecord[] {
		revision(atLifeRevision);
		const rows = this.db
			.prepare(
				"SELECT * FROM life_work_ancestry WHERE world_id=? AND life_revision<=? ORDER BY life_revision,subject_kind,subject_id",
			)
			.all(worldId, atLifeRevision);
		const result = new Map<string, WorkAncestryRecord>();
		for (const row of rows) {
			const item = {
				subject: { kind: row["subject_kind"], id: row["subject_id"] },
				lifeRevision: row["life_revision"],
				refs: JSON.parse(String(row["refs_json"])),
			};
			if (row["digest"] !== lifeDigest(item)) invalid();
			const parsed = parseWorkAncestry([item])[0];
			if (!parsed) invalid();
			result.set(`${parsed.subject.kind}:${parsed.subject.id}`, parsed);
		}
		return [...result.values()].sort((a, b) =>
			`${a.subject.kind}:${a.subject.id}`.localeCompare(
				`${b.subject.kind}:${b.subject.id}`,
			),
		);
	}
	allowed(worldId: string, subject: WorkSubject): boolean {
		return workSubjectAllowed(
			this.snapshot(worldId),
			this.ancestry(worldId),
			subject,
		);
	}
	recordStep(step: LifeStep): void {
		if (!step.outcome) invalid();
		for (const item of stepWorkAncestry(step))
			this.db
				.prepare(
					"INSERT INTO life_work_ancestry(world_id,subject_kind,subject_id,refs_json,digest,life_revision) VALUES(?,?,?,?,?,?)",
				)
				.run(
					step.worldId,
					item.subject.kind,
					item.subject.id,
					canonicalLifeJson(item.refs),
					lifeDigest(item),
					item.lifeRevision,
				);
		for (const { record, agentId, experienceId } of workExperiences(step))
			if (step.outcome.commit.experiences.some((e) => e.id === experienceId))
				this.db
					.prepare("INSERT INTO life_work_experiences VALUES(?,?,?,?,?,?,?)")
					.run(
						step.worldId,
						record.source.receipt.receiptId,
						record.source.receipt.receiptRevision,
						agentId,
						experienceId,
						record.inputId,
						step.source.life.revision + 1,
					);
	}
	validateSteps(steps: LifeStep[]): void {
		const ancestry = steps.flatMap((step) =>
			stepWorkAncestry(step).map((item) => ({
				world_id: step.worldId,
				subject_kind: item.subject.kind,
				subject_id: item.subject.id,
				refs_json: canonicalLifeJson(item.refs),
				digest: lifeDigest(item),
				life_revision: item.lifeRevision,
			})),
		);
		const experiences = steps.flatMap((step) =>
			workExperiences(step)
				.filter((x) =>
					step.outcome?.commit.experiences.some((e) => e.id === x.experienceId),
				)
				.map(({ record, agentId, experienceId }) => ({
					world_id: step.worldId,
					receipt_id: record.source.receipt.receiptId,
					receipt_revision: record.source.receipt.receiptRevision,
					agent_id: agentId,
					experience_id: experienceId,
					input_id: record.inputId,
					life_revision: step.source.life.revision + 1,
				})),
		);
		const sort = (a: unknown, b: unknown) =>
			canonicalLifeJson(a).localeCompare(canonicalLifeJson(b));
		if (
			!isDeepStrictEqual(
				ancestry.sort(sort),
				this.db
					.prepare("SELECT * FROM life_work_ancestry")
					.all()
					.map((r) => ({ ...r }))
					.sort(sort),
			) ||
			!isDeepStrictEqual(
				experiences.sort(sort),
				this.db
					.prepare("SELECT * FROM life_work_experiences")
					.all()
					.map((r) => ({ ...r }))
					.sort(sort),
			)
		)
			invalid();
	}
	configure(config: LifeConfig): void {
		const current = this.snapshot(config.worldId),
			digest = workDigest(config);
		if (current.workConfigDigest === digest) return;
		const next = {
			...current,
			revision: current.revision + 1,
			permissionRevision: revision(current.permissionRevision + 1),
			workConfigDigest: digest,
		};
		this.save(
			current,
			next,
			{
				kind: "configuration",
				configRevision: config.revision,
				workConfigDigest: digest,
			},
			null,
		);
	}
	admit(value: LifeInputV2): AdmissionReceipt {
		const input = parseLifeInput(value);
		if (input.version !== 2 || input.consumedLifeRevision !== null) invalid();
		const previous = this.snapshot(input.worldId);
		const old = this.db
			.prepare(
				"SELECT 1 FROM life_work_history WHERE world_id=? AND input_id=?",
			)
			.get(input.worldId, input.id);
		if (old) return this.access.admit(input);
		if (input.source.operation === "upsert") {
			const config = this.access.config(input.worldId);
			if (
				config.version !== 2 ||
				!config.work ||
				!input.source.fields ||
				!config.work.rules.some(
					(rule) => rule.categoryId === input.source.fields?.categoryId,
				)
			)
				throw Error("Work influence is not configured for this category");
		}
		const next = this.applyInput(previous, input);
		const receipt = this.access.admit(input);
		if (receipt.replayed) invalid();
		this.save(previous, next, { kind: "input", inputId: input.id }, input.id);
		return receipt;
	}
	validate(worldId: string): void {
		const state = this.snapshot(worldId);
		if (state.workConfigDigest !== workDigest(this.access.config(worldId)))
			invalid();
		const ids = new Set(
			this.db
				.prepare(
					"SELECT input_id FROM life_work_history WHERE world_id=? AND input_id IS NOT NULL",
				)
				.all(worldId)
				.map((row) => row["input_id"]),
		);
		for (const input of this.access.inputs(worldId))
			if (input.version === 2 && !ids.has(input.id)) invalid();
	}
	private applyInput(
		state: WorkEvidenceSnapshot,
		input: LifeInputV2,
	): WorkEvidenceSnapshot {
		const source = input.source,
			prior = state.records.find(
				(record) =>
					record.source.receipt.receiptId === source.receipt.receiptId,
			);
		if (prior) {
			const a = prior.source.receipt,
				b = source.receipt;
			if (
				b.receiptRevision < a.receiptRevision ||
				source.policyRevision < prior.source.policyRevision
			)
				invalid();
			if (b.receiptRevision === a.receiptRevision && !isDeepStrictEqual(a, b))
				invalid();
			for (const key of [
				"taskId",
				"turnId",
				"taskRevision",
				"ownerAgentId",
				"attributionStatus",
				"participantAgentIds",
			] as const)
				if (!isDeepStrictEqual(a[key], b[key])) invalid();
			if (
				b.receiptRevision === a.receiptRevision &&
				source.policyRevision === prior.source.policyRevision
			)
				invalid();
		}
		const permissionChanged =
			!prior ||
			prior.source.policyRevision !== source.policyRevision ||
			prior.source.receipt.receiptRevision !== source.receipt.receiptRevision ||
			prior.source.operation !== source.operation;
		return {
			...state,
			revision: revision(state.revision + 1),
			permissionRevision: revision(
				state.permissionRevision + Number(permissionChanged),
			),
			records: [
				...state.records.filter((record) => record !== prior),
				{ inputId: input.id, source },
			].sort((a, b) =>
				a.source.receipt.receiptId.localeCompare(b.source.receipt.receiptId),
			),
		};
	}
	private save(
		previous: WorkEvidenceSnapshot,
		next: WorkEvidenceSnapshot,
		event: WorkHistoryEvent,
		inputId: string | null,
	): void {
		this.db
			.prepare("INSERT INTO life_work_history VALUES (?,?,?,?,?,?)")
			.run(
				next.worldId,
				next.revision,
				inputId,
				canonicalLifeJson(event),
				lifeDigest(previous),
				lifeDigest(next),
			);
		this.db
			.prepare(
				"INSERT INTO life_work_state VALUES (?,?,?) ON CONFLICT(world_id) DO UPDATE SET state_json=excluded.state_json,digest=excluded.digest",
			)
			.run(next.worldId, canonicalLifeJson(next), lifeDigest(next));
	}
}
