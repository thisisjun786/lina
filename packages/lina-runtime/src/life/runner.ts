import { randomBytes, randomUUID } from "node:crypto";
import type { AgentProfile } from "../../../lina-core/src/agents/types.ts";
import type { WorldAutonomyPort } from "../../../lina-core/src/world/autonomy-store-types.ts";
import type {
	LifeLease,
	LifeStep,
} from "../../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { IdentityPolicySnapshot } from "../../../lina-core/src/world/life-types.ts";
import type { WorldSocialPort } from "../../../lina-core/src/world/social-store-types.ts";
import { LifeExecutionError } from "./actor.ts";
import { runLifeDirector } from "./director.ts";
import type { LifeModelPort } from "./model-port.ts";
import type { LifeClock } from "./scheduler.ts";
import type { SocialEnginePort } from "./social/port.ts";

export interface LifeForeground {
	active(): boolean;
	subscribe(listener: () => void): () => void;
}
export interface LifeRunnerOptions {
	store: WorldAutonomyPort & WorldSocialPort;
	model: LifeModelPort;
	engine: SocialEnginePort;
	identity(worldId: string): {
		identity: IdentityPolicySnapshot;
		profiles: AgentProfile[];
		modelSettingsRevision: number;
	};
	clock: LifeClock;
	entropy?: () => number;
	owner?: string;
	leaseMs?: number;
	foreground: LifeForeground;
}
export class LifeRunnerUnavailable extends Error {
	constructor(
		readonly status:
			| "closed"
			| "busy"
			| "foreground"
			| "paused"
			| "not_configured",
		readonly missing: string[] = [],
	) {
		super(`LIFE ${status}${missing.length ? `: ${missing.join(", ")}` : ""}`);
	}
}
export interface LifeRunner {
	run(
		worldId: string,
		idempotencyKey: string,
		expectedConfigRevision: number,
		signal: AbortSignal,
	): Promise<LifeStep>;
	cancel(worldId?: string, reason?: "cancelled" | "stale"): void;
	close(): Promise<void>;
}

export function createLifeRunner(options: LifeRunnerOptions): LifeRunner {
	const owner = options.owner ?? `life-${randomUUID()}`;
	const leaseMs = options.leaseMs ?? 30_000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 3)
		throw Error("Invalid LIFE lease duration");
	const entropy = options.entropy ?? (() => randomBytes(4).readUInt32BE());
	let closed = false;
	let active: {
		worldId: string;
		controller: AbortController;
		done: Promise<LifeStep>;
	} | null = null;
	let closing: Promise<void> | null = null;
	const cancel = (
		worldId?: string,
		reason: "cancelled" | "stale" = "cancelled",
	) => {
		if (active && (worldId === undefined || active.worldId === worldId))
			active.controller.abort(
				new LifeExecutionError(
					reason,
					reason === "stale"
						? "LIFE source changed"
						: "LIFE background work cancelled",
				),
			);
	};
	const unsubscribe = options.foreground.subscribe(() => {
		if (options.foreground.active()) cancel();
	});
	function releaseOwnedLease(lease: LifeLease) {
		try {
			options.store.releaseLifeLease(lease, options.clock.now());
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Stale LIFE lease")
				throw error;
			const schedule = options.store.lifeStatus(
				lease.worldId,
				options.clock.now(),
			).schedule;
			const current = schedule?.lease;
			// A fenced release wrote nothing. Ignore only a confirmed release or takeover.
			if (
				!schedule ||
				(current &&
					current.owner === lease.owner &&
					current.generation === lease.generation &&
					current.token === lease.token)
			)
				throw error;
		}
	}

	async function execute(
		worldId: string,
		key: string,
		revision: number,
		controller: AbortController,
	): Promise<LifeStep> {
		const signal = controller.signal;
		signal.throwIfAborted();
		const identity = options.identity(worldId);
		options.store.invalidateLifeIdentity(
			worldId,
			identity,
			options.clock.now(),
		);
		const status = options.store.lifeStatus(worldId, options.clock.now());
		if (status.status === "paused" || status.status === "not_configured")
			throw new LifeRunnerUnavailable(status.status, status.missing);
		const prepared = options.store.prepareLifeStep(
			{
				worldId,
				idempotencyKey: key,
				expectedConfigRevision: revision,
				owner,
				nowMs: options.clock.now(),
				leaseMs,
				...identity,
			},
			entropy,
		);
		// Terminal replay does not acquire a lease and must not release its historical token.
		if (
			prepared.status === "accepted" ||
			prepared.status === "failed" ||
			prepared.status === "stale"
		)
			return prepared;
		let lease = prepared.lease;
		const current = () => options.store.lifeStep(worldId, prepared.id);
		const heartbeat = new AbortController();
		const guard = () => {
			signal.throwIfAborted();
			if (options.foreground.active())
				throw new LifeExecutionError(
					"cancelled",
					"LIFE yielded to foreground work",
				);
			const identity = options.identity(worldId);
			if (
				lifeDigest(identity) !==
				lifeDigest({
					identity: prepared.source.identity,
					profiles: prepared.source.profiles,
					modelSettingsRevision: prepared.source.modelSettingsRevision,
				})
			) {
				options.store.invalidateLifeIdentity(
					worldId,
					identity,
					options.clock.now(),
				);
				throw new LifeExecutionError(
					"stale",
					"LIFE identity or model settings changed",
				);
			}
			lease = options.store.renewLifeLease(lease, options.clock.now(), leaseMs);
		};
		const renewal = renewUntilStopped(
			() => lease,
			(next) => {
				lease = next;
			},
			controller,
			heartbeat.signal,
		);
		try {
			guard();
			if (prepared.status !== "ready")
				await runLifeDirector({
					...options,
					signal,
					entropy,
					step: current,
					lease: () => lease,
					guard,
				});
			guard();
			options.store.acceptLifeStep(
				lease,
				prepared.id,
				options.identity(worldId),
				options.clock.now(),
			);
			return current();
		} catch (error) {
			const reason =
				error instanceof LifeExecutionError
					? error.reason
					: signal.aborted
						? "cancelled"
						: "unavailable";
			try {
				return options.store.failLifeStep(
					lease,
					prepared.id,
					reason,
					options.clock.now(),
				);
			} catch (failure) {
				const step = current();
				if (step.status === "stale" || step.status === "accepted") return step;
				throw new AggregateError(
					[error, failure],
					"LIFE failure could not be recorded under the current lease",
				);
			}
		} finally {
			heartbeat.abort();
			await renewal;
			releaseOwnedLease(lease);
		}
	}
	async function renewUntilStopped(
		lease: () => LifeLease,
		setLease: (lease: LifeLease) => void,
		controller: AbortController,
		signal: AbortSignal,
	) {
		try {
			while (!signal.aborted) {
				await options.clock.waitUntil(
					options.clock.now() + Math.floor(leaseMs / 3),
					signal,
				);
				if (!signal.aborted)
					setLease(
						options.store.renewLifeLease(lease(), options.clock.now(), leaseMs),
					);
			}
		} catch (error) {
			if (!signal.aborted)
				controller.abort(
					new LifeExecutionError(
						"stale",
						error instanceof Error ? error.message : "LIFE lease lost",
					),
				);
		}
	}
	return {
		async run(worldId, key, revision, signal) {
			if (closed) throw new LifeRunnerUnavailable("closed");
			if (active) throw new LifeRunnerUnavailable("busy");
			if (options.foreground.active())
				throw new LifeRunnerUnavailable("foreground");
			signal.throwIfAborted();
			const controller = new AbortController();
			const abort = () => controller.abort(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			// Defer execution one microtask so ownership exists even during native preparation.
			const done = Promise.resolve().then(() =>
				execute(worldId, key, revision, controller),
			);
			active = { worldId, controller, done };
			try {
				return await done;
			} finally {
				signal.removeEventListener("abort", abort);
				active = null;
			}
		},
		cancel,
		close() {
			if (closing) return closing;
			closed = true;
			unsubscribe();
			cancel();
			closing = (async () => {
				const running = active;
				if (running) await Promise.allSettled([running.done]);
				await options.model.close();
			})().catch((error) => {
				closing = null;
				throw error;
			});
			return closing;
		},
	};
}
