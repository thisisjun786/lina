import type { LifeConfig } from "./authoring-types.ts";
import type { LifeModelReceipts } from "./autonomy-model-receipts.ts";
import type { LifeSchedulePersistence } from "./autonomy-schedule.ts";
import type {
	LifeLease,
	LifeModelReconciliation,
	LifeModelRequest,
	PreparedLifeModelRequest,
} from "./autonomy-types.ts";
import { identifier, jsonBoundary, lifeDigest, revision } from "./life-json.ts";
import type { LifeViewLimits, SideEffectIntent } from "./life-types.ts";
import type { PublicationJobs } from "./publication-jobs.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "./publication-model.ts";
import type { PublicationPersistence } from "./publication-persistence.ts";
import {
	publicationAttemptId,
	publicationJobId,
	publicationReplyJobId,
} from "./publication-record-validation.ts";
import {
	type PublicationRuns,
	parsePublicationRunInput,
} from "./publication-runs.ts";
import type {
	PublicationAuthor,
	PublicationDecision,
	PublicationJob,
	PublicationMaterial,
	PublicationPost,
	PublicationRunInput,
} from "./publication-types.ts";
import { parsePublicationDecision } from "./publication-validation.ts";
import { fields } from "./validation.ts";

interface Access {
	auditSource?(job: PublicationJob): void;
	publish(job: PublicationJob): PublicationPost | null;
	canPublish(job: PublicationJob): boolean;
	configAt(worldId: string, revision: number): LifeConfig;
	historical(material: PublicationMaterial): PublicationMaterial | null;
	config(worldId: string): LifeConfig;
	activeAgents(worldId: string): string[];
	effects(worldId: string): SideEffectIntent[];
	replyParents?(worldId: string): string[];
	replyMaterial?(
		worldId: string,
		parentPostId: string,
		authorAgentId: string,
		recipientId: string,
		limits: LifeViewLimits,
	): PublicationMaterial | null;
	material(
		worldId: string,
		intentId: string,
		authorAgentId: string,
		recipientIds: string[],
		limits: LifeViewLimits,
	): PublicationMaterial | null;
}
/** Synchronous publication execution state; WorldStore owns every surrounding transaction. */
export class PublicationExecution {
	constructor(
		private readonly settings: PublicationPersistence,
		private readonly jobs: PublicationJobs,
		private readonly runs: PublicationRuns,
		private readonly models: LifeModelReceipts,
		private readonly schedules: LifeSchedulePersistence,
		private readonly access: Access,
	) {}
	private blocked(
		worldId: string,
		mode: "manual" | "automatic",
	): string | null {
		const config = this.access.config(worldId),
			settings = this.settings.settings(worldId);
		if (
			!settings ||
			!config.publication ||
			!config.run ||
			!config.models?.actor ||
			!config.usage ||
			!config.limits
		)
			return "not_configured";
		if (mode === "automatic" && config.run.mode === "paused") return "paused";
		if (mode === "automatic" && config.publication.mode !== "automatic")
			return "manual_publication";
		if (
			settings.maxJobsPerRun === 0 ||
			config.limits.maxModelCalls === 0 ||
			settings.maxActionsPerChain === 0
		)
			return "capacity";
		return null;
	}
	private candidates(worldId: string) {
		const config = this.access.config(worldId);
		if (!config.publication || !config.limits) return [];
		const { maxChars, maxRecords } = config.limits.evaluation;
		const limits = { maxChars, maxRecords };
		const authors = this.access.activeAgents(worldId);
		const candidates: Array<{
			kind: "event" | "reply";
			sourceId: string;
			author: string;
			recipient: string;
		}> = [];
		for (const effect of this.access.effects(worldId))
			for (const author of authors)
				for (const recipient of config.publication.recipientIds)
					if (
						this.access.material(
							worldId,
							effect.id,
							author,
							[recipient],
							limits,
						)
					)
						candidates.push({
							kind: "event",
							sourceId: effect.id,
							author,
							recipient,
						});
		for (const parentId of this.access.replyParents?.(worldId) ?? [])
			for (const author of authors)
				for (const recipient of config.publication.recipientIds)
					if (
						this.access.replyMaterial?.(
							worldId,
							parentId,
							author,
							recipient,
							limits,
						)
					)
						candidates.push({
							kind: "reply",
							sourceId: parentId,
							author,
							recipient,
						});
		return candidates;
	}
	/** A read-only queue probe; only begin() may discover jobs and acquire a lease. */
	automaticInput(worldId: string): PublicationRunInput | null {
		const pending = this.runs.pending(worldId);
		if (pending[0]) return pending[0].input;
		if (this.blocked(worldId, "automatic")) return null;
		const config = this.access.config(worldId),
			settings = this.settings.settings(worldId);
		if (!settings || !config.limits) return null;
		const jobs = this.jobs.list(worldId),
			existing = new Set(jobs.map((job) => job.id));
		const frontier = jobs
			.filter((job) => job.status === "pending")
			.map((job) => ({ jobId: job.id, attemptId: job.attemptId }));
		for (const { kind, sourceId, author, recipient } of this.candidates(
			worldId,
		)) {
			const id =
				kind === "event"
					? publicationJobId(worldId, sourceId, author, recipient)
					: publicationReplyJobId(worldId, sourceId, author, recipient);
			if (!existing.has(id)) {
				existing.add(id);
				frontier.push({ jobId: id, attemptId: publicationAttemptId(id, 1) });
			}
		}
		// Match begin(): existing durable row order followed by newly discovered candidates.
		// A key for a different batch can replay a completed run while leaving work pending.
		const batch = frontier.slice(
			0,
			Math.min(settings.maxJobsPerRun, config.limits.maxModelCalls),
		);
		if (!batch.length) return null;
		return {
			requestKey: `publication-auto-v2-${lifeDigest({ worldId, configRevision: config.revision, settingsRevision: settings.revision, batch })}`,
			expectedConfigRevision: config.revision,
			expectedSettingsRevision: settings.revision,
			mode: "automatic",
		};
	}
	begin(
		worldId: string,
		value: PublicationRunInput,
		owner: string,
		leaseMs: number,
	) {
		const input = parsePublicationRunInput(value),
			prior = this.runs.find(worldId, input.requestKey),
			config = this.access.config(worldId),
			settings = this.settings.settings(worldId);
		if (prior) {
			if (lifeDigest(prior.input) !== lifeDigest(input))
				throw Error("Publication run request conflict");
			if (prior.status !== "running") return prior;
			return this.runs.attachLease(
				worldId,
				prior.id,
				this.schedules.acquire(worldId, owner, config.revision, leaseMs),
			);
		}
		if (
			input.expectedConfigRevision !== config.revision ||
			input.expectedSettingsRevision !== (settings?.revision ?? 0)
		)
			throw Error("Publication run configuration conflict");
		const blocked = this.blocked(worldId, input.mode);
		if (blocked) return this.runs.begin(worldId, input, [], null, blocked);
		if (!settings || !config.publication || !config.limits)
			throw Error("Publication configuration missing");
		if (this.runs.pending(worldId).length)
			return this.runs.begin(worldId, input, [], null, "pending_run");
		const lease = this.schedules.acquire(
			worldId,
			owner,
			config.revision,
			leaseMs,
		);
		for (const { kind, sourceId, author, recipient } of this.candidates(
			worldId,
		))
			if (kind === "event")
				this.jobs.discover(worldId, sourceId, author, recipient);
			else this.jobs.discoverReply(worldId, sourceId, author, recipient);
		const batch = this.jobs
			.list(worldId)
			.filter((job) => job.status === "pending")
			.slice(0, Math.min(settings.maxJobsPerRun, config.limits.maxModelCalls))
			.map((job) => ({ jobId: job.id, attemptId: job.attemptId }));
		const run = this.runs.begin(
			worldId,
			input,
			batch,
			batch.length ? lease : null,
			null,
		);
		if (!batch.length) this.schedules.release(lease);
		return run;
	}
	private owned(
		lease: LifeLease,
		runId: string,
		jobId: string,
	): PublicationJob {
		this.schedules.assert(lease);
		const run = this.runs.get(lease.worldId, runId),
			item = run.batch[run.nextIndex];
		if (
			run.status !== "running" ||
			!run.lease ||
			run.lease.generation !== lease.generation ||
			run.lease.token !== lease.token ||
			run.lease.owner !== lease.owner ||
			item?.jobId !== jobId
		)
			throw Error("Publication run ownership conflict");
		const job = this.jobs.get(lease.worldId, jobId);
		if (item.attemptId !== job.attemptId)
			throw Error("Publication run attempt changed");
		return job;
	}
	private currentMaterial(job: PublicationJob): PublicationMaterial | null {
		if (!this.access.activeAgents(job.worldId).includes(job.authorAgentId))
			return null;
		const config = this.access.config(job.worldId);
		if (job.version === 2)
			return config.limits
				? (this.access.replyMaterial?.(
						job.worldId,
						job.source.parentPostId,
						job.authorAgentId,
						job.recipientId,
						{
							maxChars: config.limits.evaluation.maxChars,
							maxRecords: config.limits.evaluation.maxRecords,
						},
					) ?? null)
				: null;
		return config.limits
			? this.access.material(
					job.worldId,
					job.intentId,
					job.authorAgentId,
					[job.recipientId],
					{
						maxChars: config.limits.evaluation.maxChars,
						maxRecords: config.limits.evaluation.maxRecords,
					},
				)
			: null;
	}
	freeze(
		lease: LifeLease,
		runId: string,
		jobId: string,
		author: PublicationAuthor,
		modelSettingsRevision: number,
	): PublicationJob {
		const job = this.owned(lease, runId, jobId),
			run = this.runs.get(lease.worldId, runId),
			blocked = this.blocked(lease.worldId, run.input.mode);
		if (blocked) throw Error(`Publication ${blocked}`);
		if (
			this.access.config(lease.worldId).revision !==
				run.input.expectedConfigRevision ||
			this.settings.settings(lease.worldId)?.revision !==
				run.input.expectedSettingsRevision
		)
			throw Error("Publication frozen run configuration changed");
		const material = this.currentMaterial(job);
		if (!material) throw Error("Publication disclosure changed");
		const frozen = this.jobs.freeze(
			lease.worldId,
			jobId,
			material,
			author,
			modelSettingsRevision,
		);
		return this.access.canPublish(frozen)
			? frozen
			: this.jobs.withhold(job.worldId, jobId, "activity_limit");
	}
	assertCurrent(
		worldId: string,
		jobId: string,
		author: PublicationAuthor,
		modelSettingsRevision: number,
	): PublicationJob {
		const job = this.jobs.get(worldId, jobId),
			material = this.currentMaterial(job);
		if (
			!job.material ||
			!material ||
			lifeDigest(job.material) !== lifeDigest(material) ||
			lifeDigest(job.author) !== lifeDigest(author) ||
			job.modelSettingsRevision !== modelSettingsRevision
		)
			throw Error("Publication source changed before dispatch");
		return job;
	}
	assertDispatch(
		worldId: string,
		jobId: string,
		author: PublicationAuthor,
		modelSettingsRevision: number,
	): PublicationJob {
		const job = this.assertCurrent(
			worldId,
			jobId,
			author,
			modelSettingsRevision,
		);
		const owners = this.runs.pending(worldId).filter((run) => {
			const item = run.batch[run.nextIndex];
			return item?.jobId === job.id && item.attemptId === job.attemptId;
		});
		const run = owners[0];
		if (
			job.status !== "prepared" ||
			owners.length !== 1 ||
			!run?.lease ||
			this.blocked(worldId, run.input.mode)
		)
			throw Error("Publication dispatch authority unavailable");
		this.owned(run.lease, run.id, job.id);
		if (!this.access.canPublish(job)) throw Error("Publication activity limit");
		return job;
	}
	assertOutbound(
		request: LifeModelRequest,
		author: PublicationAuthor,
		modelSettingsRevision: number,
	) {
		if (request.version !== 2)
			throw Error("Publication model ownership required");
		const job = this.assertDispatch(
			request.worldId,
			request.jobId,
			author,
			modelSettingsRevision,
		);
		const record = this.models.get(request.worldId, request.jobId, request.id);
		if (
			record.status !== "dispatched" ||
			lifeDigest(record.prepared.request) !== lifeDigest(request)
		)
			throw Error("Publication outbound requires its exact dispatched receipt");
		this.models.assertOutbound(request, this.access.config(request.worldId));
		return job;
	}
	prepare(lease: LifeLease, runId: string, value: PreparedLifeModelRequest) {
		const r = value.request;
		if (r.version !== 2) throw Error("Publication model ownership required");
		const job = this.owned(lease, runId, r.jobId),
			config = this.access.config(lease.worldId),
			route = config.models?.actor,
			run = this.runs.get(lease.worldId, runId);
		if (
			job.status !== "prepared" ||
			r.worldId !== job.worldId ||
			r.id !== publicationModelId(job.attemptId) ||
			r.agentId !== job.authorAgentId ||
			r.modelSettingsRevision !== job.modelSettingsRevision ||
			r.provider !== route?.provider ||
			r.model !== route.model ||
			this.blocked(job.worldId, run.input.mode)
		)
			throw Error("Publication model route or state mismatch");
		if (!job.author || job.modelSettingsRevision === null)
			throw Error("Missing publication author");
		this.assertCurrent(
			job.worldId,
			job.id,
			job.author,
			job.modelSettingsRevision,
		);
		if (
			lifeDigest({ systemPrompt: r.systemPrompt, input: r.input }) !==
			lifeDigest(buildPublicationModelInput(job))
		)
			throw Error("Publication model input differs from permitted source");
		return this.models.prepare(value, config);
	}
	dispatch(lease: LifeLease, runId: string, jobId: string, requestId: string) {
		const job = this.owned(lease, runId, jobId),
			run = this.runs.get(lease.worldId, runId);
		if (
			job.status !== "prepared" ||
			requestId !== publicationModelId(job.attemptId) ||
			this.blocked(job.worldId, run.input.mode) ||
			!job.author ||
			job.modelSettingsRevision === null
		)
			throw Error("Publication dispatch state changed");
		this.assertDispatch(
			job.worldId,
			job.id,
			job.author,
			job.modelSettingsRevision,
		);
		return this.models.dispatch(
			job.worldId,
			job.id,
			requestId,
			this.access.config(job.worldId),
		);
	}
	finish(
		worldId: string,
		jobId: string,
		requestId: string,
		result: LifeModelReconciliation,
	) {
		const job = this.jobs.get(worldId, jobId),
			record = this.models.finish(worldId, jobId, requestId, result);
		// Reconciliation may outlive permission/lease changes; keep usage, never infer a new call.
		if (requestId !== publicationModelId(job.attemptId)) return record;
		if (record.status === "unknown" || record.status === "dispatched")
			this.jobs.unknown(worldId, jobId);
		else if (record.status === "failed")
			this.jobs.withhold(worldId, jobId, "model_failed", true);
		else if (record.status === "completed") {
			const { inputTokens, outputTokens, totalTokens } = record.usage;
			if (inputTokens === null || outputTokens === null || totalTokens === null)
				this.jobs.unknown(worldId, jobId);
			else if (
				inputTokens > record.reservation.inputTokens ||
				outputTokens > record.reservation.outputTokens
			)
				this.jobs.withhold(worldId, jobId, "model_budget", true);
			else {
				let decision: PublicationDecision;
				try {
					decision = parsePublicationDecision(
						JSON.parse(record.result?.text ?? ""),
						job.material?.allowedClaims.map((c) => c.id) ?? [],
						job.version === 2 ? "reply" : "event",
					);
				} catch {
					this.jobs.withhold(worldId, jobId, "invalid_model_output", true);
					return record;
				}
				if (
					!["ready", "published", "skipped", "failed", "withheld"].includes(
						job.status,
					)
				)
					this.jobs.ready(worldId, jobId, decision);
			}
		}
		return record;
	}
	retry(
		worldId: string,
		jobId: string,
		input: { requestKey: string; expectedRevision: number },
	) {
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedRevision"]);
		identifier(input.requestKey);
		revision(input.expectedRevision, 1);
		const job = this.jobs.get(worldId, jobId),
			record = this.models
				.list(worldId, jobId)
				.find(
					(r) => r.prepared.request.id === publicationModelId(job.attemptId),
				);
		if (
			record &&
			(record.status === "dispatched" ||
				record.status === "unknown" ||
				record.status === "prepared" ||
				(record.upstreamAttempts !== 0 &&
					(record.usage.inputTokens === null ||
						record.usage.outputTokens === null)))
		)
			throw Error("Publication model outcome requires reconciliation");
		if (
			input.expectedRevision === job.revision &&
			(job.status === "failed" || job.status === "withheld") &&
			this.runs
				.pending(worldId)
				.some((run) =>
					run.batch
						.slice(run.nextIndex)
						.some(
							(item) =>
								item.jobId === job.id && item.attemptId === job.attemptId,
						),
				)
		)
			throw Error("Advance the publication run before retry");
		return this.jobs.retry(worldId, jobId, input);
	}
	fail(lease: LifeLease, runId: string, jobId: string, reason: string) {
		const job = this.owned(lease, runId, jobId),
			records = this.models
				.list(job.worldId, job.id)
				.filter(
					(r) => r.prepared.request.id === publicationModelId(job.attemptId),
				);
		if (
			records.some((r) => r.status === "dispatched" || r.status === "unknown")
		)
			return this.jobs.unknown(job.worldId, job.id);
		this.models.cancelPrepared(job.worldId, job.id, reason);
		return this.jobs.withhold(job.worldId, job.id, reason, true);
	}
	complete(
		lease: LifeLease,
		runId: string,
		jobId: string,
		current: { author: PublicationAuthor; modelSettingsRevision: number },
	): PublicationJob {
		const saved = this.jobs.get(lease.worldId, jobId),
			run = this.runs.get(lease.worldId, runId);
		if (
			!run.batch.some(
				(item) => item.jobId === jobId && item.attemptId === saved.attemptId,
			)
		)
			throw Error("Publication run ownership conflict");
		if (
			saved.status === "published" ||
			saved.status === "skipped" ||
			saved.status === "withheld" ||
			saved.status === "failed"
		)
			return saved;
		const job = this.owned(lease, runId, jobId);
		if (job.status !== "ready") throw Error("Publication result not ready");
		if (this.blocked(job.worldId, run.input.mode) === "paused") return job;
		try {
			this.assertCurrent(
				job.worldId,
				jobId,
				current.author,
				current.modelSettingsRevision,
			);
		} catch {
			return this.jobs.withhold(job.worldId, jobId, "source_changed");
		}
		if (job.decision?.kind === "no_post" || job.decision?.kind === "no_reply")
			return this.jobs.complete(job.worldId, jobId, null);
		const post = this.access.publish(job);
		return post
			? this.jobs.complete(job.worldId, jobId, post.id)
			: this.jobs.withhold(job.worldId, jobId, "activity_limit");
	}
	audit(worldId: string): void {
		const runs = this.runs.list(worldId),
			records = this.models.list(worldId),
			matched = new Set<string>();
		for (const job of this.jobs.list(worldId)) {
			this.access.auditSource?.(job);
			for (const saved of this.jobs.history(worldId, job.id)) {
				if (!saved.material) continue;
				const material = this.access.historical(saved.material);
				if (!material || lifeDigest(material) !== lifeDigest(saved.material))
					throw Error("Publication material differs from historical authority");
				const owners = runs.filter((run) =>
					run.batch.some(
						(item) =>
							item.jobId === job.id && item.attemptId === saved.attemptId,
					),
				);
				if (
					owners.length !== 1 ||
					owners[0]?.input.expectedConfigRevision !== material.configRevision ||
					owners[0]?.input.expectedSettingsRevision !==
						material.settingsRevision
				)
					throw Error("Missing publication frozen run authority");
				const record = records.find(
					(r) => r.prepared.request.id === publicationModelId(saved.attemptId),
				);
				if (!record) continue;
				const request = record.prepared.request;
				const route = this.access.configAt(worldId, material.configRevision)
					.models?.actor;
				if (
					request.version !== 2 ||
					request.provider !== route?.provider ||
					request.model !== route.model ||
					request.jobId !== saved.id ||
					request.agentId !== saved.authorAgentId ||
					request.modelSettingsRevision !== saved.modelSettingsRevision ||
					lifeDigest({
						systemPrompt: request.systemPrompt,
						input: request.input,
					}) !== lifeDigest(buildPublicationModelInput(saved))
				)
					throw Error("Publication model differs from frozen source");
				matched.add(request.id);
			}
			if (
				job.status === "ready" ||
				job.status === "published" ||
				job.status === "skipped"
			) {
				const record = records.find(
					(r) => r.prepared.request.id === publicationModelId(job.attemptId),
				);
				if (
					record?.status !== "completed" ||
					!record.result ||
					lifeDigest(
						parsePublicationDecision(
							JSON.parse(record.result.text),
							job.material?.allowedClaims.map((c) => c.id) ?? [],
							job.version === 2 ? "reply" : "event",
						),
					) !== lifeDigest(job.decision)
				)
					throw Error("Missing publication decision receipt");
			}
		}
		if (matched.size !== records.length)
			throw Error("Orphan publication model source");
	}
	advance(lease: LifeLease, runId: string, jobId: string) {
		const job = this.owned(lease, runId, jobId);
		if (
			job.status !== "published" &&
			job.status !== "skipped" &&
			job.status !== "withheld" &&
			job.status !== "failed"
		)
			throw Error("Publication job is not terminal");
		return this.runs.advance(
			job.worldId,
			runId,
			job.id,
			job.attemptId,
			job.status,
		);
	}
}
