import { randomUUID } from "node:crypto";
import type { LifeConfig } from "../../../lina-core/src/world/authoring-types.ts";
import type { WorldAutonomyPort } from "../../../lina-core/src/world/autonomy-store-types.ts";
import type {
	LifeLease,
	LifeStep,
} from "../../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import { ModelRequestError } from "../models/errors.ts";
import type { LifeForeground, LifeRunner } from "./runner.ts";

export interface LifeClock {
	now(): number;
	waitUntil(time: number, signal: AbortSignal): Promise<void>;
}
export interface LifeSchedulerOptions {
	store: Pick<
		WorldAutonomyPort,
		"lifeStatus" | "lifeStep" | "advanceLifeSchedule" | "releaseLifeLease"
	>;
	runner: Pick<LifeRunner, "run" | "cancel">;
	worldIds(): string[];
	/** Publication can also own older LIFE worlds without autonomous simulation. */
	publicationWorldIds?(): string[];
	/** Image/avatar policies can run without an autonomous or publication schedule. */
	imageWorldIds?(): string[];
	config(worldId: string): LifeConfig;
	/** Acquires a schedule lease without selecting or creating a step. */
	acquireLease(
		worldId: string,
		expectedConfigRevision: number,
		owner: string,
		nowMs: number,
		leaseMs: number,
	): LifeLease;
	clock: LifeClock;
	foreground: LifeForeground;
	owner?: string;
	leaseMs?: number;
	onError(worldId: string, error: unknown): void;
	/** Shares this loop, cancellation and wake deadlines with simulation. */
	visitPublication?(
		worldId: string,
		signal: AbortSignal,
	): Promise<number | null>;
	visitImages?(worldId: string, signal: AbortSignal): Promise<number | null>;
}

function safeTime(time: number): number {
	if (!Number.isSafeInteger(time) || time < 0)
		throw Error("Unsafe LIFE schedule time");
	return time;
}

export function createLifeScheduler(options: LifeSchedulerOptions) {
	const owner = options.owner ?? `life-scheduler-${randomUUID()}`;
	const leaseMs = options.leaseMs ?? 30_000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 3)
		throw Error("Invalid LIFE schedule lease duration");
	const stop = new AbortController();
	let wakeVersion = 0;
	let waiting: AbortController | null = null;
	let running: Promise<void> | null = null;
	let worldRunning: string | null = null;
	const unconfiguredModels = new Set<string>();
	const armed = new Map<
		string,
		{ due: number; generation: number; revision: number }
	>();
	const wake = () => {
		unconfiguredModels.clear();
		wakeVersion++;
		waiting?.abort();
	};
	const unsubscribe = options.foreground.subscribe(() => {
		if (options.foreground.active()) armed.clear();
		wake();
	});

	function advance(
		worldId: string,
		revision: number,
		expectedDue: number | null,
		nextDue: number,
		skipped: number,
	): boolean {
		const now = safeTime(options.clock.now());
		const lease = options.acquireLease(worldId, revision, owner, now, leaseMs);
		try {
			const schedule = options.store.lifeStatus(worldId, now).schedule;
			if (schedule?.nextDue !== expectedDue) return false;
			options.store.advanceLifeSchedule(lease, now, safeTime(nextDue), skipped);
			return true;
		} finally {
			options.store.releaseLifeLease(lease, options.clock.now());
		}
	}
	function stepKey(
		worldId: string,
		revision: number,
		generation: number,
		due: number,
	) {
		return `schedule-${lifeDigest({ worldId, revision, generation, due })}`;
	}
	async function invoke(worldId: string, key: string, revision: number) {
		worldRunning = worldId;
		try {
			return await options.runner.run(worldId, key, revision, stop.signal);
		} finally {
			worldRunning = null;
		}
	}
	async function visitOutput(
		worldId: string,
		visitor: LifeSchedulerOptions["visitPublication"],
	): Promise<number | null> {
		if (!visitor || stop.signal.aborted || options.foreground.active())
			return null;
		worldRunning = worldId;
		try {
			const next = await visitor(worldId, stop.signal);
			return next === null ? null : safeTime(next);
		} finally {
			worldRunning = null;
		}
	}
	function budgetRetry(
		worldId: string,
		config: LifeConfig,
		step?: LifeStep,
	): number | null {
		const status = options.store.lifeStatus(worldId, options.clock.now());
		if (
			!config.usage ||
			status.usage.unknownRequests ||
			(step && step.error !== "budget")
		)
			return null;
		if (
			step?.models.some(
				(row) =>
					(row.usage.inputTokens ?? 0) > row.reservation.inputTokens ||
					(row.usage.outputTokens ?? 0) > row.reservation.outputTokens,
			)
		)
			return null;
		// The store uses a rolling window. A full configured window is a conservative wake boundary.
		return safeTime(options.clock.now() + config.usage.windowMs);
	}
	async function resume(
		worldId: string,
		config: LifeConfig,
		stepId: string,
		interval: number,
		afterAccepted?: () => Promise<void>,
	) {
		const pending = options.store.lifeStep(worldId, stepId);
		const result = await invoke(
			worldId,
			pending.idempotencyKey,
			config.revision,
		);
		if (stop.signal.aborted) return null;
		if (result.status !== "accepted")
			return budgetRetry(worldId, config, result);
		const schedule = options.store.lifeStatus(
			worldId,
			options.clock.now(),
		).schedule;
		const due = schedule?.nextDue;
		if (
			schedule &&
			due !== null &&
			due !== undefined &&
			pending.idempotencyKey ===
				stepKey(worldId, config.revision, schedule.generation, due)
		) {
			const next = safeTime(due + interval);
			advance(
				worldId,
				config.revision,
				due,
				next,
				schedule.lastSkippedIntervals,
			);
			if (afterAccepted) await afterAccepted();
			return next;
		}
		if (afterAccepted) await afterAccepted();
		return safeTime(options.clock.now());
	}

	async function visit(
		worldId: string,
		afterAccepted?: () => Promise<void>,
	): Promise<number | null> {
		if (stop.signal.aborted || options.foreground.active()) return null;
		const config = options.config(worldId);
		const interval = config.clock?.intervalMs;
		if (config.run?.mode !== "automatic" || !interval || !config.clock)
			return null;
		const now = safeTime(options.clock.now());
		const status = options.store.lifeStatus(worldId, now);
		if (status.status === "paused" || status.status === "not_configured")
			return null;
		const schedule = status.schedule;
		if (schedule?.lease && schedule.lease.expiresAt > now)
			return schedule.lease.expiresAt;
		if (status.activeStepId !== null)
			return resume(
				worldId,
				config,
				status.activeStepId,
				interval,
				afterAccepted,
			);
		if (status.status === "budget_exhausted")
			return budgetRetry(worldId, config);
		if (status.status === "needs_attention") return null;
		let due = schedule?.nextDue ?? null;
		if (due === null) {
			advance(worldId, config.revision, null, now + interval, 0);
			return safeTime(now + interval);
		}
		if (schedule?.lastStepId) {
			const accepted = options.store.lifeStep(worldId, schedule.lastStepId);
			if (
				accepted.status === "accepted" &&
				accepted.idempotencyKey ===
					stepKey(worldId, config.revision, schedule.generation, due)
			) {
				const next = safeTime(due + interval);
				if (
					!advance(
						worldId,
						config.revision,
						due,
						next,
						schedule.lastSkippedIntervals,
					)
				)
					return safeTime(now + interval);
				due = next;
			}
		}
		if (due > now) return due;
		const dueCount = Math.floor((now - due) / interval) + 1;
		const planned = armed.get(worldId);
		// Only a future occurrence observed by this live scheduler can be a delayed timer.
		// One full missed interval is backlog; a restarted scheduler has no armed occurrence.
		const delayedWake =
			planned?.due === due &&
			planned.generation === schedule?.generation &&
			planned.revision === config.revision &&
			now - due < interval;
		const allowance =
			config.clock.maxCatchUpSteps === 0
				? delayedWake || (now - due) % interval === 0
					? 1
					: 0
				: config.clock.maxCatchUpSteps;
		const runs = Math.min(dueCount, Math.max(due === now ? 1 : 0, allowance));
		const skipped = dueCount - runs;
		if (skipped) {
			const next = safeTime(due + skipped * interval);
			if (!advance(worldId, config.revision, due, next, skipped))
				return safeTime(now + interval);
			due = next;
		}
		for (let i = 0; i < runs; i++) {
			if (stop.signal.aborted || options.foreground.active()) return null;
			const current = options.store.lifeStatus(worldId, options.clock.now());
			if (
				current.schedule?.nextDue !== due ||
				options.config(worldId).revision !== config.revision
			)
				return null;
			const key = stepKey(
				worldId,
				config.revision,
				current.schedule.generation,
				due,
			);
			const step = await invoke(worldId, key, config.revision);
			if (stop.signal.aborted) return null;
			if (step.status !== "accepted") return budgetRetry(worldId, config, step);
			const next = safeTime(due + interval);
			if (!advance(worldId, config.revision, due, next, skipped))
				return safeTime(now + interval);
			due = next;
			if (afterAccepted) await afterAccepted();
		}
		return due;
	}

	async function wait(deadline: number | null, version: number) {
		if (stop.signal.aborted || wakeVersion !== version) return;
		waiting = new AbortController();
		const signal = AbortSignal.any([waiting.signal, stop.signal]);
		try {
			if (deadline !== null) await options.clock.waitUntil(deadline, signal);
			else
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else
						signal.addEventListener("abort", () => resolve(), { once: true });
				});
		} catch (error) {
			if (!signal.aborted) throw error;
		} finally {
			waiting = null;
		}
	}
	async function loop() {
		while (!stop.signal.aborted) {
			const version = wakeVersion;
			let deadline: number | null = null;
			if (!options.foreground.active()) {
				const simulationWorlds = new Set(options.worldIds());
				const worlds = new Set([
					...simulationWorlds,
					...(options.publicationWorldIds?.() ?? []),
					...(options.imageWorldIds?.() ?? []),
				]);
				for (const worldId of [...worlds].sort()) {
					if (stop.signal.aborted) break;
					try {
						if (unconfiguredModels.has(worldId)) {
							const images = await visitOutput(worldId, options.visitImages);
							if (images !== null)
								deadline =
									deadline === null ? images : Math.min(deadline, images);
							continue;
						}
						let publication: number | null = null;
						let images: number | null = null;
						const publish =
							options.visitPublication || options.visitImages
								? async () => {
										// Replace the prior deadline: this visit may consume its remaining work.
										publication = await visitOutput(
											worldId,
											options.visitPublication,
										);
										images = await visitOutput(worldId, options.visitImages);
									}
								: undefined;
						if (publish) await publish();
						const next = simulationWorlds.has(worldId)
							? await visit(worldId, publish)
							: null;
						armed.delete(worldId);
						const now = safeTime(options.clock.now());
						if (next !== null && next > now && !options.foreground.active()) {
							const schedule = options.store.lifeStatus(worldId, now).schedule;
							if (schedule?.nextDue === next)
								armed.set(worldId, {
									due: next,
									generation: schedule.generation,
									revision: schedule.configRevision,
								});
						}
						if (next !== null)
							deadline = deadline === null ? next : Math.min(deadline, next);
						if (publication !== null)
							deadline =
								deadline === null
									? publication
									: Math.min(deadline, publication);
						if (images !== null)
							deadline =
								deadline === null ? images : Math.min(deadline, images);
					} catch (error) {
						armed.delete(worldId);
						if (stop.signal.aborted) break;
						options.onError(worldId, error);
						if (
							error instanceof ModelRequestError &&
							error.code === "not_configured"
						) {
							unconfiguredModels.add(worldId);
							continue;
						}
						const interval = options.config(worldId).clock?.intervalMs;
						if (interval) {
							const retry = safeTime(options.clock.now() + interval);
							deadline = deadline === null ? retry : Math.min(deadline, retry);
						}
					}
				}
			}
			await wait(deadline, version);
		}
	}
	return {
		start() {
			if (stop.signal.aborted) throw Error("LIFE scheduler closed");
			if (!running)
				running = loop().catch((error) => {
					options.onError("scheduler", error);
					stop.abort(error);
				});
		},
		wake,
		async close() {
			stop.abort();
			unsubscribe();
			if (worldRunning) options.runner.cancel(worldRunning);
			wake();
			await running;
		},
	};
}
