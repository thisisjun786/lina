import type { LifeConfig } from "../../lina-core/src/world/authoring-types.ts";
import type {
	LifeModelReconciliation,
	LifeModelRecord,
	LifeModelRequest,
	LifeModelResult,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { pureStep } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import type { LifeInvocationContext } from "../src/life/actor.ts";
import type { LifeModelPort } from "../src/life/model-port.ts";
import type { LifeClock } from "../src/life/scheduler.ts";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export class RuntimeClock implements LifeClock {
	time = 0;
	private waiters = new Set<{ time: number; finish(error?: unknown): void }>();
	private changed = deferred<void>();
	now() {
		return this.time;
	}
	waitUntil(time: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (time <= this.time) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const abort = () => waiter.finish(signal.reason);
			const waiter = {
				time,
				finish: (error?: unknown) => {
					this.waiters.delete(waiter);
					signal.removeEventListener("abort", abort);
					if (error) reject(error);
					else resolve();
				},
			};
			this.waiters.add(waiter);
			signal.addEventListener("abort", abort, { once: true });
			this.changed.resolve();
			this.changed = deferred<void>();
		});
	}
	advance(time: number) {
		this.time = time;
		for (const waiter of [...this.waiters])
			if (waiter.time <= time) waiter.finish();
	}
	async waitingAt(time: number) {
		while (![...this.waiters].some((waiter) => waiter.time === time))
			await this.changed.promise;
	}
	get pending() {
		return this.waiters.size;
	}
}

export class RuntimeForeground {
	private value = false;
	private listeners = new Set<() => void>();
	active = () => this.value;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	set(value: boolean) {
		this.value = value;
		for (const listener of this.listeners) listener();
	}
}

/** Synthetic model boundary only; no native or provider qualification is claimed. */
export class RuntimeModel implements LifeModelPort {
	requests: LifeModelRequest[] = [];
	prepared: PreparedLifeModelRequest[] = [];
	journal = new Map<string, LifeModelReconciliation>();
	closed = false;
	onComplete?: (
		request: PreparedLifeModelRequest,
		signal: AbortSignal,
	) => Promise<LifeModelResult>;
	text: (request: LifeModelRequest) => string = () => "{}";
	async prepare(request: LifeModelRequest, signal: AbortSignal) {
		signal.throwIfAborted();
		const prepared = {
			version: 1 as const,
			request: structuredClone(request),
			inputDigest: lifeDigest(request),
			capabilityFingerprint: "b".repeat(64),
			nativeReference: `fixture-${request.id}`,
		};
		this.prepared.push(prepared);
		return prepared;
	}
	result(prepared: PreparedLifeModelRequest): LifeModelResult {
		const request = prepared.request;
		return {
			version: 1,
			requestId: request.id,
			inputDigest: prepared.inputDigest,
			capabilityFingerprint: prepared.capabilityFingerprint,
			nativeReference: prepared.nativeReference,
			provider: request.provider,
			model: request.model,
			threadId: request.id,
			turnId: request.id,
			text: this.text(request),
			usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
			upstreamAttempts: 1,
		};
	}
	async complete(prepared: PreparedLifeModelRequest, signal: AbortSignal) {
		signal.throwIfAborted();
		this.requests.push(prepared.request);
		this.journal.set(prepared.request.id, { status: "unknown" });
		const result = this.onComplete
			? await this.onComplete(prepared, signal)
			: this.result(prepared);
		this.journal.set(prepared.request.id, { status: "completed", result });
		return result;
	}
	async reconcile(
		prepared: PreparedLifeModelRequest,
	): Promise<LifeModelReconciliation> {
		return (
			this.journal.get(prepared.request.id) ?? { status: "not_dispatched" }
		);
	}
	async close() {
		this.closed = true;
	}
}

export function runtimeConfig(): LifeConfig {
	return {
		version: 1,
		worldId: "test-world",
		revision: 1,
		clock: { stepSize: 1, intervalMs: 100, maxCatchUpSteps: 0 },
		run: { mode: "manual" },
		models: {
			director: { provider: "director-route", model: "director-model" },
			actor: { provider: "actor-route", model: "actor-model" },
		},
		limits: {
			maxActorActions: 8,
			maxCausalDepth: 2,
			maxModelCalls: 6,
			evaluation: {
				maxChars: 10000,
				maxRecords: 20,
				maxDepth: 4,
				maxOperations: 1000,
			},
		},
		usage: {
			windowMs: 1000,
			maxInputTokens: 100000,
			maxOutputTokens: 50000,
			maxImages: 0,
		},
		publication: null,
		images: null,
		avatars: null,
	};
}

/** Port-level invocation fixture; SQLite acceptance is tested separately through WorldStore. */
export function invocationFixture() {
	const step = pureStep();
	step.source.config = runtimeConfig();
	const clock = new RuntimeClock(),
		model = new RuntimeModel(),
		controller = new AbortController();
	const trace: string[] = [];
	const find = (id: string) => {
		const record = step.models.find((row) => row.prepared.request.id === id);
		if (!record) throw Error("Missing fixture receipt");
		return record;
	};
	const store: LifeInvocationContext["store"] = {
		lifeStatus: () => ({
			worldId: step.worldId,
			status: "ready",
			missing: [],
			schedule: null,
			activeStepId: step.id,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				reservedInputTokens: 0,
				reservedOutputTokens: 0,
				unknownRequests: 0,
				upstreamAttempts: 0,
				monetaryCost: "unknown",
			},
		}),
		prepareLifeModel(_lease, _stepId, prepared, now) {
			trace.push("reserve");
			const record: LifeModelRecord = {
				prepared,
				status: "prepared",
				preparedAt: now,
				dispatchedAt: null,
				result: null,
				usage: { inputTokens: null, outputTokens: null, totalTokens: null },
				reservation: {
					inputTokens: prepared.request.limits.maxInputTokens,
					outputTokens: prepared.request.limits.maxOutputTokens,
				},
				upstreamAttempts: 0,
				error: null,
			};
			step.models.push(record);
			return record;
		},
		dispatchLifeModel(_lease, _step, id, now) {
			trace.push("dispatch");
			const record = find(id);
			const dispatched = record.status === "prepared";
			record.status = "dispatched";
			record.dispatchedAt = now;
			return { record, dispatched };
		},
		finishLifeModel(_world, _step, id, result) {
			trace.push("finish");
			const record = find(id);
			if (result.status === "completed") {
				record.result = result.result;
				record.usage = result.result.usage;
				record.upstreamAttempts = 1;
				record.status = "completed";
			} else if (result.status === "failed") {
				record.status = "failed";
				record.usage = result.usage;
				record.error = result.reason;
				record.upstreamAttempts = result.upstreamAttempts;
			} else if (result.status === "unknown") {
				record.status = "unknown";
				record.upstreamAttempts = null;
			}
			return record;
		},
	};
	const context: LifeInvocationContext = {
		store,
		model,
		clock,
		signal: controller.signal,
		step: () => step,
		lease: () => step.lease,
		guard: () => controller.signal.throwIfAborted(),
	};
	return { context, step, clock, model, controller, trace };
}
