import { z } from "zod";
import { sourceProofsCurrent } from "../../../lina-core/src/source-policy.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import {
	contentHash,
	parseConclusions,
} from "../../../lina-memory/src/engine/reasoning.ts";
import type { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import type { EngineRecord } from "../../../lina-memory/src/engine/types.ts";
import { hash } from "../../../lina-memory/src/engine/validation.ts";
import {
	defaultEnginePolicy,
	type EnginePolicySnapshot,
} from "./policy-settings.ts";
import type { ContextServices } from "./port.ts";

export interface ConsolidationConfig {
	consolidate: NonNullable<ContextServices["consolidate"]>;
	policy?: () => EnginePolicySnapshot;
	modelSettingsRevision: () => number;
}
export interface ConsolidationStatus {
	state:
		| "unavailable"
		| "disabled"
		| "pending"
		| "running"
		| "committed"
		| "failed"
		| "withheld";
	pending: number;
	running: number;
	committed: number;
	failed: number;
	withheld: number;
	completedPages: number;
	totalPages: number;
	incomplete: boolean;
	error: string | null;
}
const searchSchema = z.strictObject({
	queries: z.array(z.string().trim().min(1).max(512)).min(1).max(3),
});
const proposalSchema = z.strictObject({ proposals: z.unknown() });
function projection(record: EngineRecord) {
	return {
		id: record.id,
		revision: record.revision,
		subject: record.subject,
		kind: record.kind,
		key: record.key,
		text: record.text,
		support: record.support,
		evidence: record.evidence,
		reasoning: record.reasoning,
		sources: record.sources,
	};
}

/** Runs inside Companion's single lifecycle; owns neither DB nor timers. */
export class MemoryConsolidation {
	private config: ConsolidationConfig | undefined;
	private epoch = 0;
	private trigger: string | undefined;
	private totalPages = 0;
	private error: string | null = null;
	private unavailable = false;
	private coverageIncomplete = false;
	constructor(
		private readonly mind: EngineStore,
		private readonly journal: DurableStore,
		private readonly call: (
			run: (signal: AbortSignal) => Promise<string>,
		) => Promise<string>,
	) {}
	configure(config: ConsolidationConfig | undefined) {
		this.config = config;
		this.epoch++;
	}
	status(): ConsolidationStatus {
		const jobs = this.mind
			.reasoningJobs()
			.filter((j) => j.seed.trigger === this.trigger);
		const counts = {
			pending: 0,
			running: 0,
			committed: 0,
			failed: 0,
			withheld: 0,
		};
		for (const job of jobs) counts[job.state]++;
		const completedPages = jobs.filter(
			(j) => j.seed.stage === "induction" && j.state === "committed",
		).length;
		const enabled = (this.config?.policy ?? defaultEnginePolicy)().memory
			.enabled;
		const state =
			!this.config || this.unavailable
				? "unavailable"
				: !enabled
					? "disabled"
					: counts.running
						? "running"
						: counts.failed
							? "failed"
							: counts.withheld
								? "withheld"
								: counts.pending || completedPages < this.totalPages
									? "pending"
									: "committed";
		return {
			state,
			...counts,
			completedPages,
			totalPages: this.totalPages,
			incomplete: this.coverageIncomplete || completedPages < this.totalPages,
			error: this.error,
		};
	}
	nextDelay(now: number): number | undefined {
		if (
			!this.config ||
			this.unavailable ||
			(this.config.policy ?? defaultEnginePolicy)().memory.enabled === false
		)
			return undefined;
		const jobs = this.mind
			.reasoningJobs()
			.filter(
				(j) =>
					j.seed.trigger === this.trigger &&
					(j.state === "pending" || j.state === "failed") &&
					j.attempts < j.seed.maxAttempts,
			);
		return jobs.length
			? Math.max(0, Math.min(...jobs.map((j) => j.retryAt)) - now)
			: undefined;
	}
	async run(
		signal: AbortSignal,
		allowCharacterGrowth: () => boolean,
	): Promise<void> {
		const config = this.config;
		if (!config) return;
		const policy = (config.policy ?? defaultEnginePolicy)();
		if (!policy.memory.enabled) return;
		let settingsRevision: number;
		try {
			settingsRevision = config.modelSettingsRevision();
			this.unavailable = false;
		} catch {
			this.error = "not_configured";
			this.unavailable = true;
			return;
		}
		const epoch = this.epoch;
		const all = this.mind.reasoningCandidates(),
			direct = all.filter((r) => !r.reasoning);
		if (!direct.length) {
			this.totalPages = 0;
			return;
		}
		const trigger = hash({
			algorithm: 1,
			policy,
			settingsRevision,
			records: direct.map((r) => ({
				id: r.id,
				content: contentHash(r),
				sources: r.sources,
				proofs: r.sourceProofs,
				support: r.support,
			})),
		});
		this.trigger = trigger;
		this.error = null;
		this.coverageIncomplete = false;
		this.mind.supersedeReasoning(trigger);
		const pages: EngineRecord[][] = [];
		let page: EngineRecord[] = [],
			chars = 0;
		for (const record of direct) {
			const size = JSON.stringify(projection(record)).length;
			if (
				page.length &&
				(chars + size > policy.memory.inputChars - 1024 ||
					page.length >= policy.memory.maxVisits)
			) {
				pages.push(page);
				page = [];
				chars = 0;
			}
			if (size > policy.memory.inputChars - 1024) {
				this.coverageIncomplete = true;
				this.error = "input_budget_insufficient";
				continue;
			}
			page.push(record);
			chars += size;
		}
		if (page.length) pages.push(page);
		this.totalPages = pages.length + (this.coverageIncomplete ? 1 : 0);
		for (let index = 0; index < pages.length; index++)
			this.mind.enqueueReasoning({
				trigger,
				stage: "deduction",
				page: index,
				policyRevision: policy.revision,
				modelSettingsRevision: settingsRevision,
				maxAttempts: policy.memory.maxAttempts,
			});
		let processed = 0;
		for (let index = 0; index < pages.length && processed < 20; index++) {
			for (const stage of ["deduction", "induction"] as const) {
				signal.throwIfAborted();
				if (epoch !== this.epoch) return;
				const jobs = this.mind.reasoningJobs();
				if (
					stage === "induction" &&
					!jobs.some(
						(j) =>
							j.seed.trigger === trigger &&
							j.seed.page === index &&
							j.seed.stage === "deduction" &&
							j.state === "committed",
					)
				)
					continue;
				const seed = {
					trigger,
					stage,
					page: index,
					policyRevision: policy.revision,
					modelSettingsRevision: settingsRevision,
					maxAttempts: policy.memory.maxAttempts,
				};
				const pageRecords = pages[index] ?? [];
				let started: ReturnType<EngineStore["beginReasoning"]>;
				try {
					started = this.mind.beginReasoning(
						seed,
						pageRecords.map((r) => r.id),
					);
				} catch {
					this.error = "input_unavailable";
					return;
				}
				if (!started) continue;
				processed++;
				let input = started.input;
				const assertCurrent = () => {
					signal.throwIfAborted();
					if (
						epoch !== this.epoch ||
						hash((config.policy ?? defaultEnginePolicy)()) !== hash(policy) ||
						config.modelSettingsRevision() !== settingsRevision
					)
						throw Error("configuration_changed");
					if (this.mind.currentRevision() !== input.expectedRevision)
						throw Error("stale_revision");
					if (
						!sourceProofsCurrent(input.promptProofs, (id) =>
							this.journal.sourceEntry(id),
						)
					)
						throw Error("source_withheld");
				};
				try {
					// Induction sees committed deduction records when the remaining page budget permits.
					if (stage === "induction") {
						const extra = this.mind
							.reasoningCandidates()
							.filter(
								(r) =>
									r.reasoning?.kind === "deduction" &&
									!input.records.some((p) => p.id === r.id),
							)
							.slice(
								0,
								Math.max(0, policy.memory.maxVisits - input.records.length),
							);
						if (
							extra.length &&
							JSON.stringify([...input.records, ...extra].map(projection))
								.length <
								policy.memory.inputChars - 1024
						)
							input = this.mind.expandReasoning(
								started.claim,
								[],
								extra.map((r) => r.id),
							);
					}
					for (let round = 0; ; round++) {
						assertCurrent();
						const remainingSearches = Math.max(
							0,
							policy.memory.maxSearchRounds - round,
						);
						const body = {
							stage,
							remainingSearches,
							records: input.records.map(projection),
							contract:
								"Return only queries or proposals. Proposals cite provided recordId/revision. Do not change authored identity. If nothing is justified return proposals: [].",
						};
						const originals: {
							entryId: string;
							text: string;
							clipped: boolean;
						}[] = [];
						const sourceIds = [
							...new Set(
								input.records.flatMap((record) =>
									record.sources.map((source) => source.entryId),
								),
							),
						];
						for (const entryId of sourceIds) {
							const entry = this.journal.sourceEntry(entryId);
							if (
								!entry ||
								!input.promptProofs.some((proof) => proof.entryId === entryId)
							)
								throw Error("source_withheld");
							const quote =
								input.records
									.flatMap((record) => record.sources)
									.find((source) => source.entryId === entryId)?.quote ?? "";
							const start = Math.max(0, entry.text.indexOf(quote) - 200);
							let length = Math.min(2400, entry.text.length - start);
							let added = false;
							while (length > 0) {
								const candidate = {
									entryId,
									text: entry.text.slice(start, start + length),
									clipped: start > 0 || length < entry.text.length,
								};
								if (
									JSON.stringify({
										...body,
										originals: [...originals, candidate],
									}).length <= policy.memory.inputChars
								) {
									originals.push(candidate);
									added = true;
									break;
								}
								length = Math.floor(length / 2);
							}
							if (!added) {
								this.coverageIncomplete = true;
								break;
							}
						}
						const payload = JSON.stringify({ ...body, originals });
						if (payload.length > policy.memory.inputChars)
							throw Error("input_budget_insufficient");
						input = this.mind.freezeReasoningPayload(started.claim, payload);
						const reply = await this.call((boundedSignal) =>
							config.consolidate(
								payload,
								boundedSignal,
								assertCurrent,
								undefined,
								policy.memory.maxOutputTokens,
							),
						);
						assertCurrent();
						const raw: unknown = JSON.parse(reply);
						if (raw && typeof raw === "object" && "queries" in raw) {
							const request = searchSchema.parse(raw);
							if (!remainingSearches) {
								this.coverageIncomplete = true;
								throw Error("search_budget_exhausted");
							}
							const hits = [
								...new Map(
									request.queries
										.flatMap((q) =>
											this.mind.recall(q, { limit: policy.memory.maxVisits }),
										)
										.map((r) => [r.id, r]),
								).values(),
							].filter((r) => !input.records.some((p) => p.id === r.id));
							const selected: EngineRecord[] = [];
							for (const hit of hits) {
								if (
									input.records.length + selected.length >=
										policy.memory.maxVisits ||
									JSON.stringify(
										[...input.records, ...selected, hit].map(projection),
									).length >=
										policy.memory.inputChars - 1024
								) {
									this.coverageIncomplete = true;
									break;
								}
								selected.push(hit);
							}
							if (selected.length)
								input = this.mind.expandReasoning(
									started.claim,
									request.queries,
									selected.map((r) => r.id),
								);
							continue;
						}
						const proposals = parseConclusions(
							proposalSchema.parse(raw).proposals,
						);
						if (proposals.some((p) => p.reasoningKind !== stage))
							throw Error("invalid_output");
						if (
							!allowCharacterGrowth() &&
							proposals.some((p) => p.subject !== "user")
						)
							throw Error("character_growth_disabled");
						assertCurrent();
						this.mind.applyConclusions(
							{
								requestId: started.claim.id,
								expectedRevision: input.expectedRevision,
								proposals,
								claim: started.claim,
							},
							signal,
						);
						break;
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "invalid_output";
					this.error =
						message === "source_withheld"
							? message
							: signal.aborted
								? "cancelled"
								: message === "stale_revision"
									? message
									: "invalid_output";
					try {
						this.mind.finishReasoning(
							started.claim,
							this.error as
								| "source_withheld"
								| "cancelled"
								| "stale_revision"
								| "invalid_output",
						);
					} catch {
						this.error = "claim_superseded";
					}
					if (signal.aborted || epoch !== this.epoch) return;
				}
			}
		}
	}
}
