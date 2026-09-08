import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { LifeRunner } from "./runner.ts";
import type { LifeClock } from "./scheduler.ts";

interface Options {
	store: Pick<
		WorldStore,
		| "automaticPublicationInput"
		| "pendingPublicationRuns"
		| "publicationExecutionStatus"
		| "lifeConfig"
	>;
	runner: Pick<LifeRunner, "publishScheduled">;
	clock: LifeClock;
}

/** No polling cadence: wake for an owned lease, a configured budget window or actual remaining work. */
export async function visitLifePublication(
	options: Options,
	worldId: string,
	signal: AbortSignal,
): Promise<number | null> {
	signal.throwIfAborted();
	const { store, clock, runner } = options;
	const input = store.automaticPublicationInput(worldId);
	if (!input) return null;
	const now = clock.now(),
		status = store.publicationExecutionStatus(worldId);
	if (status.schedule?.lease && status.schedule.lease.expiresAt > now)
		return status.schedule.lease.expiresAt;
	// Saved work must reconcile even while paused or its reservation exhausts the budget.
	if (!store.pendingPublicationRuns(worldId).length) {
		const budget = store.lifeConfig(worldId).usage;
		if (
			!budget?.maxInputTokens ||
			!budget.maxOutputTokens ||
			status.usage.unknownRequests
		)
			return null;
		if (
			status.usage.inputTokens + status.usage.reservedInputTokens >=
				budget.maxInputTokens ||
			status.usage.outputTokens + status.usage.reservedOutputTokens >=
				budget.maxOutputTokens
		)
			return now + budget.windowMs;
	}
	const run = await runner.publishScheduled(worldId, input, signal);
	// Unknown or paused work waits for a state change/restart, never an immediate retry loop.
	if (run.status !== "completed" || signal.aborted) return null;
	return store.automaticPublicationInput(worldId) ? clock.now() : null;
}
