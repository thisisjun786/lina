import { join } from "node:path";
import { parseLifeModelResult } from "../../lina-core/src/world/autonomy-record-validation.ts";
import type {
	LifeModelRequest,
	LifeModelResult,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import type { LifeModelPort } from "../../lina-runtime/src/life/model-port.ts";
import {
	createLifeModelGateway,
	type LifeModelGateway,
} from "./life-model-gateway.ts";
import { LifeModelJournal } from "./life-model-journal.ts";
import {
	bindLifeNative,
	LifeNativeOwnership,
	runLifeNative,
} from "./life-model-native.ts";
import { type CodexLifeModelOptions, lifePlan } from "./life-model-policy.ts";
import { qualifyLifeNative } from "./life-model-qualification.ts";
import {
	lifeModelRequest,
	lifePrepared,
	lifeReference,
} from "./life-model-validation.ts";

export type { CodexLifeModelOptions } from "./life-model-policy.ts";

export function createCodexLifeModel(
	options: CodexLifeModelOptions,
): LifeModelPort {
	const ownership = new LifeNativeOwnership();
	const active = new Map<Promise<unknown>, AbortController>();
	const qualified = new Set<string>();
	let closed = false,
		closing: Promise<void> | undefined;
	const operation = <T>(
		signal: AbortSignal,
		timeoutMs: number,
		run: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		if (closed) return Promise.reject(Error("LIFE model is closed"));
		const controller = new AbortController();
		const bound = AbortSignal.any([signal, controller.signal]);
		const timer = setTimeout(
			() => controller.abort(Error("LIFE model timed out")),
			timeoutMs,
		);
		const pending = Promise.resolve().then(() => run(bound));
		active.set(pending, controller);
		void pending
			.finally(() => {
				clearTimeout(timer);
				active.delete(pending);
			})
			.catch(() => undefined);
		return pending;
	};
	const qualify = async (
		plan: ReturnType<typeof lifePlan>,
		journal: LifeModelJournal,
		signal: AbortSignal,
	) => {
		if (qualified.has(plan.fingerprint)) return;
		await qualifyLifeNative(plan, journal.directory, ownership, signal);
		signal.throwIfAborted();
		qualified.add(plan.fingerprint);
	};
	const assertCurrent = (request: LifeModelRequest, fingerprint: string) => {
		if (lifePlan(options, request).fingerprint !== fingerprint)
			throw Error("LIFE native capability fingerprint changed");
	};
	return {
		async prepare(value, signal) {
			const request = lifeModelRequest(value);
			return operation(signal, request.limits.timeoutMs, async (bound) => {
				bound.throwIfAborted();
				const plan = lifePlan(options, request);
				const prepared: PreparedLifeModelRequest = {
					version: 1,
					request,
					inputDigest: lifeDigest(request),
					capabilityFingerprint: plan.fingerprint,
					nativeReference: lifeReference(request),
				};
				const journal = new LifeModelJournal(options.stateRoot, prepared, true);
				await qualify(plan, journal, bound);
				assertCurrent(request, plan.fingerprint);
				bound.throwIfAborted();
				return structuredClone(prepared);
			});
		},
		async complete(value, signal) {
			const prepared = lifePrepared(value);
			return operation(
				signal,
				prepared.request.limits.timeoutMs,
				async (bound) => {
					const journal = new LifeModelJournal(options.stateRoot, prepared);
					const prior = journal.reconcile();
					if (prior.status === "completed") return prior.result;
					if (prior.status !== "not_dispatched")
						throw Error(
							`LIFE request already ${prior.status}; no inference retry`,
						);
					const request = prepared.request;
					// Claim before any await or local check, including cancellation. A lost
					// owner remains unknown; a competing completion cannot claim this ID.
					journal.write("preflight", {
						version: 1,
						requestId: request.id,
						inputDigest: prepared.inputDigest,
						pid: process.pid,
					});
					let gate: LifeModelGateway | undefined;
					let releaseGate: (() => Promise<void>) | undefined;
					let outboundStarted = false;
					try {
						bound.throwIfAborted();
						const plan = lifePlan(options, request);
						assertCurrent(request, prepared.capabilityFingerprint);
						await qualify(plan, journal, bound);
						const credential = plan.selection.connection.requiresAdmissionToken
							? options.providerEnv?.()["OPENCODEX_API_AUTH_TOKEN"]
							: undefined;
						if (plan.selection.connection.requiresAdmissionToken && !credential)
							throw Error("LIFE provider credential unavailable");
						bound.throwIfAborted();
						journal.write("dispatch", {
							version: 1,
							requestId: request.id,
							inputDigest: prepared.inputDigest,
							pid: process.pid,
						});
						const gateway = createLifeModelGateway({
							baseUrl: plan.selection.connection.baseUrl,
							credential,
							request,
							signal: bound,
							beforeOutbound() {
								bound.throwIfAborted();
								assertCurrent(request, plan.fingerprint);
								options.beforeOutbound?.(structuredClone(request));
								bound.throwIfAborted();
								outboundStarted = true;
								journal.write("outbound", {
									version: 1,
									requestId: request.id,
									inputDigest: prepared.inputDigest,
									upstreamAttempts: 1,
								});
							},
							observed(usage) {
								journal.write("usage", usage);
							},
						});
						gate = gateway;
						releaseGate = ownership.retain(() => gateway.close());
						journal.write("transport", {
							baseUrl: gate.baseUrl,
							nativeRoot: "native",
						});
						const native = bindLifeNative(
							plan,
							join(journal.directory, "native"),
							gate,
						);
						const result = await runLifeNative({
							plan: native,
							request,
							nonce: gate.nonce,
							signal: bound,
							ownership,
							onBinding(value) {
								journal.write("binding", value);
							},
						});
						if (
							gate.upstreamAttempts !== 1 ||
							gate.failure ||
							gate.deniedPosts ||
							!gate.responseReceived
						)
							throw Error("LIFE native gateway did not complete exactly once");
						const usage = gate.usage;
						if (
							(["inputTokens", "outputTokens", "totalTokens"] as const).some(
								(key) =>
									usage[key] !== null && usage[key] !== result.usage[key],
							)
						)
							throw Error(
								"LIFE native usage disagrees with upstream transport",
							);
						const completed: LifeModelResult = {
							version: 1,
							requestId: request.id,
							inputDigest: prepared.inputDigest,
							capabilityFingerprint: prepared.capabilityFingerprint,
							nativeReference: prepared.nativeReference,
							provider: request.provider,
							model: request.model,
							...result,
							usage,
							upstreamAttempts: 1,
						};
						const validated = parseLifeModelResult(completed, prepared);
						journal.write("result", validated);
						return validated;
					} catch {
						// Zero is evidence from this claimed execution, never an inference
						// from a missing marker. Revalidate storage before writing a terminal.
						const observed = new LifeModelJournal(
							options.stateRoot,
							prepared,
						).reconcile();
						if (
							observed.status === "unknown" &&
							((!outboundStarted && !journal.has("outbound")) ||
								(gate?.responseReceived && journal.has("outbound")))
						)
							journal.write("failure", {
								status: "failed",
								usage: gate?.upstreamAttempts
									? gate.usage
									: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
								upstreamAttempts: journal.has("outbound") ? 1 : 0,
								reason: "LIFE native request failed",
							});
						throw Error(
							journal.has("failure")
								? "LIFE native request failed"
								: "LIFE dispatched request outcome is unknown",
						);
					} finally {
						await releaseGate?.();
						if (gate)
							journal.write("gateway", {
								upstreamAttempts: gate.upstreamAttempts,
								deniedPosts: gate.deniedPosts,
								responseReceived: gate.responseReceived,
								usage: gate.usage,
								closed: true,
							});
					}
				},
			);
		},
		async reconcile(value) {
			const prepared = lifePrepared(value);
			return new LifeModelJournal(options.stateRoot, prepared).reconcile();
		},
		close() {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				for (const controller of active.values())
					controller.abort(Error("LIFE model closed"));
				await ownership.close();
				await Promise.allSettled([...active.keys()]);
				await ownership.close();
			})();
			void closing.catch(() => {
				closing = undefined;
			});
			return closing;
		},
	};
}
