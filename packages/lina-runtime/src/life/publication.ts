import type { LifeConfig } from "../../../lina-core/src/world/authoring-types.ts";
import type {
	LifeLease,
	LifeModelReconciliation,
	LifeModelRecord,
	PublicationModelRequest,
} from "../../../lina-core/src/world/autonomy-types.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../../lina-core/src/world/publication-model.ts";
import type {
	PublicationAuthor,
	PublicationJob,
	PublicationRun,
} from "../../../lina-core/src/world/publication-types.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import { MAX_WORLD_BYTES } from "../../../lina-core/src/world/validation.ts";
import { LifeExecutionError } from "./actor.ts";
import type { LifeModelPort } from "./model-port.ts";
import type { LifeClock } from "./scheduler.ts";

/** Core owns parsing, authorization, transactions and the shared receipt ledger. */
export type LifePublicationStore = Pick<
	WorldStore,
	| "lifeConfig"
	| "beginPublicationRun"
	| "publicationRun"
	| "publicationJob"
	| "freezePublicationJob"
	| "assertPublicationCurrent"
	| "preparePublicationModel"
	| "dispatchPublicationModel"
	| "finishPublicationModel"
	| "failPublicationJob"
	| "completePublicationJob"
	| "advancePublicationRun"
	| "publicationModelRecords"
	| "publicationExecutionStatus"
	| "automaticPublicationInput"
	| "pendingPublicationRuns"
>;

export interface LifePublicationOptions {
	store: LifePublicationStore;
	author(
		worldId: string,
		agentId: string,
		frozen?: PublicationAuthor | null,
	): PublicationAuthor;
	assertSourceCurrent?(job: PublicationJob): void;
}
interface Context {
	publication: LifePublicationOptions;
	run: PublicationRun;
	/** Invocation authority belongs to the trusted caller, never the persisted batch. */
	invocation: "manual" | "scheduled";
	model: LifeModelPort;
	clock: LifeClock;
	signal: AbortSignal;
	lease(): LifeLease;
	guard(): void;
	identity(worldId: string): { modelSettingsRevision: number };
	beforePrepare: ((worldId: string) => void) | undefined;
}

// Protocol implementation ceiling, identical to parseLifeModelLimits; no spend default.
const MODEL_TIMEOUT_MS = 300_000;
const terminal = (job: PublicationJob) =>
	job.status === "published" ||
	job.status === "skipped" ||
	job.status === "withheld" ||
	job.status === "failed";

function publicationAuthorized(context: Context): boolean {
	if (context.invocation === "manual") return true;
	const config = context.publication.store.lifeConfig(context.run.worldId);
	return (
		!!config.run &&
		config.run.mode !== "paused" &&
		config.publication?.mode === "automatic"
	);
}

function assertPublicationAuthorized(context: Context): void {
	if (!publicationAuthorized(context))
		throw new LifeExecutionError(
			"cancelled",
			"Scheduled publication suspended",
		);
}

function current(context: Context, job: PublicationJob) {
	assertPublicationAuthorized(context);
	context.guard();
	context.beforePrepare?.(job.worldId);
	context.publication.assertSourceCurrent?.(job);
	const author = context.publication.author(
		job.worldId,
		job.authorAgentId,
		job.author,
	);
	const { modelSettingsRevision } = context.identity(job.worldId);
	if (job.material)
		context.publication.store.assertPublicationCurrent(
			job.worldId,
			job.id,
			author,
			modelSettingsRevision,
		);
	assertPublicationAuthorized(context);
	return { author, modelSettingsRevision };
}

function requestFor(
	context: Context,
	job: PublicationJob,
	config: LifeConfig,
): PublicationModelRequest {
	const route = config.models?.actor,
		budget = config.usage,
		evaluation = config.limits?.evaluation;
	if (!route || !budget || !evaluation || job.modelSettingsRevision === null)
		throw new LifeExecutionError(
			"unavailable",
			"Publication model or evaluation configuration missing",
		);
	const { usage } = context.publication.store.publicationExecutionStatus(
		job.worldId,
	);
	const inputTokens =
		budget.maxInputTokens - usage.inputTokens - usage.reservedInputTokens;
	const outputTokens =
		budget.maxOutputTokens - usage.outputTokens - usage.reservedOutputTokens;
	if (usage.unknownRequests || inputTokens <= 0 || outputTokens <= 0)
		throw new LifeExecutionError(
			"budget",
			"LIFE token budget or unresolved usage prevents publication",
		);
	const prompt = buildPublicationModelInput(job);
	// UTF-8 can require four bytes per configured character; cap at the core envelope.
	const bytes = Math.min(MAX_WORLD_BYTES, evaluation.maxChars * 4);
	if (
		bytes <= 0 ||
		Buffer.byteLength(prompt.systemPrompt) + Buffer.byteLength(prompt.input) >
			bytes
	)
		throw new LifeExecutionError(
			"budget",
			"Publication input exceeds configured evaluation bound",
		);
	return {
		version: 2,
		id: publicationModelId(job.attemptId),
		worldId: job.worldId,
		jobId: job.id,
		lane: "publication",
		agentId: job.authorAgentId,
		...route,
		modelSettingsRevision: job.modelSettingsRevision,
		...prompt,
		limits: {
			maxInputTokens: inputTokens,
			maxOutputTokens: outputTokens,
			maxInputBytes: bytes,
			maxOutputBytes: bytes,
			timeoutMs: MODEL_TIMEOUT_MS,
		},
	};
}

/** Await cancellation acknowledgement, retaining the runner's active slot throughout. */
async function modelOperation<T>(
	context: Context,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timer = new AbortController(),
		cutoff = new AbortController();
	const signal = AbortSignal.any([context.signal, cutoff.signal]);
	const deadline = context.clock.now() + timeoutMs;
	if (!Number.isSafeInteger(deadline))
		throw Error("Unsafe publication model deadline");
	const waiting = context.clock.waitUntil(deadline, timer.signal).then(
		() =>
			cutoff.abort(
				new LifeExecutionError("cancelled", "LIFE model deadline exceeded"),
			),
		(error) => {
			if (!timer.signal.aborted) cutoff.abort(error);
		},
	);
	try {
		const result = await operation(signal);
		signal.throwIfAborted();
		return result;
	} finally {
		timer.abort();
		await waiting;
	}
}

async function reconcile(
	context: Context,
	record: LifeModelRecord,
): Promise<boolean> {
	const { request } = record.prepared;
	if (request.version !== 2) throw Error("Publication receipt owner mismatch");
	let result: LifeModelReconciliation;
	try {
		result = await context.model.reconcile(record.prepared);
	} catch {
		result = { status: "unknown" };
	}
	// A prepared receipt cannot have dispatched without crossing the durable dispatch fence.
	// Inconclusive journal reads keep its reservation and never authorize a new call.
	if (record.status === "prepared") return result.status === "not_dispatched";
	context.publication.store.finishPublicationModel(
		request.worldId,
		request.jobId,
		request.id,
		result.status === "not_dispatched" ? { status: "unknown" } : result,
	);
	return result.status === "completed" || result.status === "failed";
}

async function invoke(context: Context, job: PublicationJob): Promise<void> {
	const { store } = context.publication,
		runId = context.run.id;
	let record = store
		.publicationModelRecords(job.worldId, job.id)
		.find((r) => r.prepared.request.id === publicationModelId(job.attemptId));
	if (!record) {
		current(context, job);
		const request = requestFor(context, job, store.lifeConfig(job.worldId));
		const prepared = await modelOperation(
			context,
			request.limits.timeoutMs,
			(signal) => context.model.prepare(request, signal),
		);
		current(context, job);
		record = store.preparePublicationModel(context.lease(), runId, prepared);
	}
	if (record.status !== "prepared") return;
	current(context, job);
	const dispatched = store.dispatchPublicationModel(
		context.lease(),
		runId,
		job.id,
		record.prepared.request.id,
	);
	if (!dispatched.dispatched) return;
	try {
		await modelOperation(
			context,
			record.prepared.request.limits.timeoutMs,
			async (signal) => {
				const result = await context.model.complete(record.prepared, signal);
				// Returned usage is evidence even after cancellation or lease loss.
				store.finishPublicationModel(
					job.worldId,
					job.id,
					record.prepared.request.id,
					{ status: "completed", result },
				);
			},
		);
	} catch (error) {
		await reconcile(context, dispatched.record);
		if (context.signal.aborted) throw context.signal.reason;
		if (error instanceof LifeExecutionError) throw error;
	}
}

/** One fixed run only. Reconciliation is independent of current publication authority. */
export async function runLifePublication(
	context: Context,
): Promise<PublicationRun> {
	const { store } = context.publication,
		worldId = context.run.worldId;
	let run = context.run;
	let unresolved = false;
	for (const item of run.batch.slice(run.nextIndex)) {
		for (const record of store.publicationModelRecords(worldId, item.jobId)) {
			if (record.prepared.request.id !== publicationModelId(item.attemptId))
				continue;
			if (
				record.status === "prepared" ||
				record.status === "dispatched" ||
				record.status === "unknown"
			)
				unresolved = !(await reconcile(context, record)) || unresolved;
		}
	}
	while (run.status === "running") {
		// Recovery records prior results, but only the current caller may admit new effects.
		if (!publicationAuthorized(context)) break;
		const item = run.batch[run.nextIndex];
		if (!item) throw Error("Missing frozen publication batch item");
		let job = store.publicationJob(worldId, item.jobId);
		if (item.attemptId !== job.attemptId)
			throw Error("Publication frozen attempt changed");
		if (terminal(job)) {
			run = store.advancePublicationRun(context.lease(), run.id, job.id);
			continue;
		}
		if (unresolved || job.status === "unknown") break;
		try {
			const authority = current(context, job);
			if (job.status === "pending")
				job = store.freezePublicationJob(
					context.lease(),
					run.id,
					job.id,
					authority.author,
					authority.modelSettingsRevision,
				);
			if (job.status === "prepared") await invoke(context, job);
			job = store.publicationJob(worldId, job.id);
			if (job.status === "ready") {
				// Check pause before material revisions, since paused reconciliation keeps ready work.
				if (!publicationAuthorized(context)) break;
				job = store.completePublicationJob(
					context.lease(),
					run.id,
					job.id,
					current(context, job),
				);
			}
		} catch (error) {
			// A config change can also revoke the lease during an await. Preserve recovery work.
			if (!publicationAuthorized(context)) break;
			try {
				job = store.publicationJob(worldId, job.id);
				if (!terminal(job) && job.status !== "unknown")
					job = store.failPublicationJob(
						context.lease(),
						run.id,
						job.id,
						error instanceof LifeExecutionError
							? error.reason
							: context.signal.aborted
								? "cancelled"
								: "unavailable",
					);
			} catch (failure) {
				throw new AggregateError(
					[error, failure],
					"Publication failure could not be recorded under the current lease",
				);
			}
		}
		if (!terminal(job)) break;
		run = store.advancePublicationRun(context.lease(), run.id, job.id);
	}
	return store.publicationRun(worldId, run.id);
}
