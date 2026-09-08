import { visitLifePublication } from "./publication-scheduler.ts";
import {
	createLifeRunner,
	type LifeRunnerOptions,
	LifeRunnerUnavailable,
} from "./runner.ts";
import {
	createLifeScheduler,
	type LifeClock,
	type LifeSchedulerOptions,
} from "./scheduler.ts";

/** The fleet may replace this with the same clock injected into its WorldStore. */
export const systemLifeClock: LifeClock = {
	now: () => Date.now(),
	waitUntil(time, signal) {
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const abort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const wait = () => {
				const delay = time - Date.now();
				if (delay <= 0) {
					signal.removeEventListener("abort", abort);
					resolve();
				} else timer = setTimeout(wait, Math.min(delay, 2_147_483_647));
			};
			if (!Number.isSafeInteger(time) || time < 0) {
				reject(Error("Unsafe LIFE clock deadline"));
				return;
			}
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener("abort", abort, { once: true });
			wait();
		});
	},
};

export type LifeRuntimeOptions = LifeRunnerOptions &
	Pick<
		LifeSchedulerOptions,
		"worldIds" | "publicationWorldIds" | "config" | "acquireLease" | "onError"
	>;

/** Owns background work only. Its caller closes the world store after close resolves. */
export function createLifeRuntime(options: LifeRuntimeOptions) {
	const runner = createLifeRunner(options);
	const publication = options.publication;
	const scheduler = createLifeScheduler({
		...options,
		runner,
		...(publication
			? {
					visitPublication: (worldId: string, signal: AbortSignal) =>
						visitLifePublication(
							{ store: publication.store, runner, clock: options.clock },
							worldId,
							signal,
						),
				}
			: {}),
	});
	let closed = false;
	function identityChanged(worldId: string) {
		const now = options.clock.now();
		const pending = options.store.lifeStatus(worldId, now).activeStepId;
		// The durable fence must precede abort, whose late response may still carry usage.
		options.store.invalidateLifeIdentity(
			worldId,
			options.identity(worldId),
			now,
		);
		if (pending && options.store.lifeStep(worldId, pending).status === "stale")
			runner.cancel(worldId, "stale");
		scheduler.wake();
	}
	return {
		start() {
			if (closed) throw new LifeRunnerUnavailable("closed");
			for (const worldId of options.worldIds()) identityChanged(worldId);
			scheduler.start();
		},
		async run(...args: Parameters<typeof runner.run>) {
			if (closed) throw new LifeRunnerUnavailable("closed");
			try {
				return await runner.run(...args);
			} finally {
				scheduler.wake();
			}
		},
		async publish(...args: Parameters<typeof runner.publish>) {
			if (closed) throw new LifeRunnerUnavailable("closed");
			try {
				return await runner.publish(...args);
			} finally {
				scheduler.wake();
			}
		},
		status(worldId: string) {
			return options.store.lifeStatus(worldId, options.clock.now());
		},
		configChanged(worldId: string) {
			runner.cancel(worldId, "stale");
			scheduler.wake();
		},
		identityChanged,
		publicationChanged: scheduler.wake,
		cancel: runner.cancel,
		async close() {
			closed = true;
			runner.cancel();
			await scheduler.close();
			await runner.close();
		},
	};
}
