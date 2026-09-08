import { canonical, hash } from "../../../lina-memory/src/resources/codec.ts";
import { textPrefix } from "../../../lina-memory/src/resources/extraction.ts";
import type { ResourceMemoryClaim } from "../../../lina-memory/src/resources/memories.ts";
import type { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import { resourceEstimator } from "./worker.ts";
export function memoryGeneration(s: ContextServices, p: EnginePolicySnapshot) {
	let route: unknown = null;
	try {
		route =
			s.routeInfo?.(
				"observation",
				{ tier: "standard" },
				p.resources.outputTokens,
			) ?? null;
	} catch {
		route = "unavailable";
	}
	const revision =
		typeof route === "object" && route !== null && "settingsRevision" in route
			? Number(route.settingsRevision)
			: 0;
	return {
		policyRevision: p.revision,
		modelSettingsRevision: revision,
		routeKey: hash({ route, policy: p.resources }),
		estimatorId: resourceEstimator(s).id,
		maxAttempts: p.resources.maxAttempts,
	};
}
interface Options {
	store: ResourceStore;
	scope: () => ResourceScope;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
}
export class ResourceMemoryWorker {
	constructor(private options: Options) {}
	async run(resourceId: string, signal: AbortSignal) {
		const { store, scope, services, policy } = this.options,
			p = policy(),
			s = services(),
			beforeScope = canonical(scope());
		store.memories.refresh(scope(), resourceId);
		const job = store.memories
			.jobs(scope(), resourceId)
			.find(
				(j) =>
					j.state === "pending" &&
					canonical(j.generation) === canonical(memoryGeneration(s, p)) &&
					store.current(scope(), [j.ref]),
			);
		if (!job)
			return { state: "unavailable" as const, reason: "no_pending_capture" };
		if (
			!p.resources.enabled ||
			!s.deriveResourceMemory ||
			!s.memoryInputOverhead
		)
			return {
				state: "unavailable" as const,
				reason: "memory_service_disabled",
			};
		let claim: ResourceMemoryClaim | undefined;
		try {
			const source = store.memories.source(scope(), resourceId),
				estimator = resourceEstimator(s),
				overhead = s.memoryInputOverhead();
			if (!Number.isSafeInteger(overhead) || overhead < 0)
				throw Error("invalid_memory_overhead");
			let text = textPrefix(source.text, 262144);
			while (text && overhead + estimator.text(text) > p.resources.inputTokens)
				text = textPrefix(text, Math.floor(text.length * 0.8));
			if (!text) throw Error("memory_input_limit");
			const guard = () => {
				signal.throwIfAborted();
				if (
					canonical(scope()) !== beforeScope ||
					canonical(policy()) !== canonical(p) ||
					canonical(memoryGeneration(services(), policy())) !==
						canonical(job.generation) ||
					!store.current(scope(), [job.ref]) ||
					canonical(store.memories.source(scope(), resourceId).snapshot) !==
						canonical(source.snapshot)
				)
					throw Error("memory_source_or_policy_changed");
			};
			guard();
			const response = await s.deriveResourceMemory(
				text,
				signal,
				() => {
					guard();
					if (claim) throw Error("duplicate_memory_dispatch");
					claim = store.memories.prepare(scope(), job.id, text);
				},
				{ tier: "standard" },
				p.resources.outputTokens,
				p.resources.inputTokens,
			);
			guard();
			if (!claim) throw Error("memory_dispatch_not_observed");
			if (estimator.text(response) > p.resources.outputTokens)
				throw Error("memory_output_limit");
			const memories = store.memories.complete(
				scope(),
				claim,
				JSON.parse(response),
			);
			return { state: "ready" as const, memoryIds: memories.map((m) => m.id) };
		} catch {
			if (claim) {
				try {
					store.memories.fail(scope(), claim, "memory_generation_failed");
				} catch {
					/* Revoked scope leaves a durable prepared claim for exclusive recovery. */
				}
			}
			let state:
				| "unavailable"
				| "pending"
				| "prepared"
				| "ready"
				| "failed"
				| "unknown"
				| "stale"
				| "exhausted" = "unavailable";
			try {
				state =
					store.memories.jobs(scope(), resourceId).find((j) => j.id === job.id)
						?.state ?? "unavailable";
			} catch {}
			return {
				state,
				reason: signal.aborted ? "cancelled" : "memory_generation_failed",
			};
		}
	}
}
