import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { LifeClock } from "../life/scheduler.ts";
import type { ImageJob } from "./contracts.ts";
import { archiveEligible } from "./image-store-schema.ts";
import { IMAGE_POLL_MS } from "./jobs.ts";
import type { LifeImages } from "./life.ts";
import type { LifeImageDiscovery } from "./life-discovery.ts";
import { terminalImageState } from "./store.ts";

interface Options {
	store: Pick<
		WorldStore,
		"imageAttempts" | "imageIntent" | "imageAttemptCount" | "imageIntentAllowed"
	>;
	discovery: Pick<LifeImageDiscovery, "preview" | "freeze">;
	images: Pick<LifeImages, "run" | "resume" | "reconcile" | "read" | "archive">;
	clock: LifeClock;
	foreground(): boolean;
	completed(job: ImageJob): void;
	onError(intentId: string, error: unknown): void;
}

/** Provider status polling shares the LIFE clock; this does not set an event/avatar cadence. */
export async function visitLifeImages(
	options: Options,
	worldId: string,
	signal: AbortSignal,
): Promise<number | null> {
	signal.throwIfAborted();
	if (options.foreground()) return null;
	const { store, images, discovery, clock } = options;
	const visit = discovery.preview(worldId, clock.now());
	let next = visit.dueAtMs;
	let remaining = visit.maxJobsPerVisit;
	let progressed = false;
	const blockedOwners = new Set<string>();
	function observe(job: ImageJob) {
		if (terminalImageState(job.state)) {
			if (job.state === "completed") options.completed(job);
			return;
		}
		const poll = clock.now() + IMAGE_POLL_MS;
		next = next === null ? poll : Math.min(next, poll);
	}
	function archiveAttempt(
		attemptId: string,
		intentId: string,
		known?: ImageJob,
	) {
		if (store.imageAttemptCount(worldId, attemptId)?.archived) return;
		try {
			const current = known ?? images.read(worldId, attemptId);
			if (!archiveEligible(current)) return;
			images.archive(worldId, attemptId);
		} catch (error) {
			options.onError(intentId, error);
		}
	}
	for (const attempt of store.imageAttempts(worldId)) {
		if (signal.aborted || options.foreground()) return next;
		const intent = store.imageIntent(worldId, attempt.intentId);
		if (!intent) throw Error("Missing retained image intent");
		const state = attempt.observation?.state ?? "prepared";
		// Retain the original receipt, but an obsolete intent with no reservation
		// has never reached provider dispatch and cannot hold this owner's future slots.
		if (
			state === "prepared" &&
			store.imageAttemptCount(worldId, attempt.attemptId) === null &&
			!store.imageIntentAllowed(worldId, intent.intentId, "provider")
		)
			continue;
		if (!terminalImageState(state)) blockedOwners.add(intent.owner.agentId);
		if (
			state === "prepared" &&
			attempt.jobId !== null &&
			!store.imageIntentAllowed(worldId, intent.intentId, "provider")
		) {
			try {
				const job = await images.reconcile(worldId, attempt.attemptId, signal);
				observe(job);
				if (terminalImageState(job.state))
					blockedOwners.delete(intent.owner.agentId);
				archiveAttempt(attempt.attemptId, attempt.intentId, job);
			} catch (error) {
				if (signal.aborted) return next;
				options.onError(attempt.intentId, error);
			}
			continue;
		}
		if (state === "prepared" && intent.requestKey !== null) continue;
		if (terminalImageState(state) && attempt.delivery.kind !== "pending") {
			archiveAttempt(attempt.attemptId, attempt.intentId);
			continue;
		}
		// A candidate-only or withheld destination must not consume every later generation slot.
		if (state === "completed") {
			try {
				const current = images.read(worldId, attempt.attemptId);
				try {
					options.completed(current);
				} catch (error) {
					options.onError(attempt.intentId, error);
				}
				archiveAttempt(attempt.attemptId, attempt.intentId, current);
			} catch (error) {
				options.onError(attempt.intentId, error);
			}
			continue;
		}
		if (terminalImageState(state) && !attempt.observation?.resultFilename) {
			archiveAttempt(attempt.attemptId, attempt.intentId);
			continue;
		}
		if (state === "prepared") {
			if (remaining <= 0) continue;
			remaining--;
		}
		try {
			const job = await images.resume(
				worldId,
				attempt.attemptId,
				"scheduled",
				signal,
			);
			observe(job);
			if (terminalImageState(job.state))
				blockedOwners.delete(intent.owner.agentId);
			archiveAttempt(attempt.attemptId, attempt.intentId, job);
		} catch (error) {
			if (signal.aborted) return next;
			options.onError(attempt.intentId, error);
		}
	}
	for (const candidate of visit.candidates) {
		if (signal.aborted || options.foreground()) return next;
		if (remaining <= 0) break;
		if (blockedOwners.has(candidate.agentId)) continue;
		remaining--;
		try {
			const intent = discovery.freeze(worldId, candidate);
			const job = await images.run(
				worldId,
				intent.intentId,
				`automatic-${intent.intentId}`,
				"scheduled",
				signal,
			);
			observe(job);
			if (!terminalImageState(job.state))
				blockedOwners.add(intent.owner.agentId);
			progressed = true;
		} catch (error) {
			if (signal.aborted) return next;
			options.onError(candidate.intentId, error);
		}
	}
	// Only proven progress can request another immediate visit. Errors await a state change/deadline.
	if (
		progressed &&
		remaining === 0 &&
		discovery
			.preview(worldId, clock.now())
			.candidates.some((candidate) => !blockedOwners.has(candidate.agentId))
	)
		return clock.now();
	return next;
}
