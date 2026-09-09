import {
	isDocumentMime,
	isImageMime,
} from "../../../lina-core/src/attachments/types.ts";
import { canonical, hash } from "../../../lina-memory/src/resources/codec.ts";
import {
	extractResource,
	isResourceText,
} from "../../../lina-memory/src/resources/extraction.ts";
import { isResourceHtml } from "../../../lina-memory/src/resources/html.ts";
import type {
	IndexKind,
	ResourceClaim,
	ResourceGeneration,
	ResourceJob,
} from "../../../lina-memory/src/resources/job-codec.ts";
import type { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { ContextEstimator } from "../context/budget.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import type { ResourcePolicy } from "./policy.ts";

export function resourceEstimator(services: ContextServices): ContextEstimator {
	return (
		services.estimator ?? {
			id: "host-estimate-v1",
			kind: "host",
			text: services.estimateText,
			messages: services.estimateMessages,
		}
	);
}
export function resourceGeneration(
	services: ContextServices,
	policy: EnginePolicySnapshot,
	kind: IndexKind,
): ResourceGeneration {
	const role = kind === "extract" ? "vision" : "summary";
	let route: unknown = null,
		revision = 0;
	try {
		const value = services.routeInfo?.(
			role,
			undefined,
			policy.resources.outputTokens,
		);
		route = value ?? null;
		revision = value?.settingsRevision ?? 0;
	} catch {
		route = "unconfigured";
	}
	let key = "";
	try {
		key = services.summaryCacheKey?.() ?? "";
	} catch {
		key = "unconfigured";
	}
	return {
		policyRevision: policy.revision,
		modelSettingsRevision: revision,
		routeKey: hash({ role, route, key, policy: policy.resources }),
		estimatorId: resourceEstimator(services).id,
		maxAttempts: policy.resources.maxAttempts,
	};
}
interface Options {
	store: ResourceStore;
	scope: () => ResourceScope;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
}
interface Frame {
	ref: ResourceJob["refs"][number];
	title: string;
	kind: string;
	text: string | null;
	complete: boolean;
	derivedId: string | null;
	stale: boolean;
}
interface Packed {
	text: string;
	complete: boolean;
}
function pack(
	frames: Frame[],
	policy: ResourcePolicy,
	services: ContextServices,
): Packed {
	const overhead = services.resourceInputOverhead?.("summary");
	if (overhead === undefined || !Number.isSafeInteger(overhead) || overhead < 0)
		throw Error("resource_input_overhead_unavailable");
	const estimator = resourceEstimator(services),
		empty = estimator.messages([{ role: "user", content: "" }]);
	const copy = frames.map((f) => ({ ...f }));
	let complete = copy.every((f) => f.complete);
	while (true) {
		const text = JSON.stringify({ sources: copy });
		if (
			overhead +
				estimator.messages([{ role: "user", content: text }]) -
				empty <=
			policy.inputTokens
		)
			return { text, complete };
		complete = false;
		const longest = copy.reduce<Frame | undefined>(
			(a, b) => ((b.text?.length ?? 0) > (a?.text?.length ?? 0) ? b : a),
			undefined,
		);
		if (longest?.text) {
			const points = [...longest.text];
			longest.text = points.slice(0, Math.floor(points.length / 2)).join("");
			longest.complete = false;
			continue;
		}
		if (copy.length > 1) {
			copy.pop();
			continue;
		}
		throw Error("input_budget_insufficient");
	}
}
/** One host-owned execution at a time; no timer, provider selection or installation ownership here. */
export class ResourceWorker {
	constructor(private readonly options: Options) {}
	private frames(job: ResourceJob, maxVisits: number): Frame[] {
		const { store, scope } = this.options;
		const refs = [...job.refs]
			.sort((a, b) =>
				a.resourceId === job.resourceId
					? -1
					: b.resourceId === job.resourceId
						? 1
						: 0,
			)
			.slice(0, maxVisits);
		return refs.map((ref) => {
			const r = store.get(scope(), ref.resourceId),
				derived =
					r.kind === "document"
						? store.indexing.read(scope(), r.id, "extract")
						: undefined;
			return {
				ref,
				title: r.title,
				kind: r.kind,
				text: derived?.text ?? null,
				complete: r.kind === "collection" || (derived?.complete ?? false),
				derivedId: derived?.jobId ?? null,
				stale: derived?.stale ?? false,
			};
		});
	}
	async run(
		id: string,
		signal: AbortSignal,
	): Promise<{ jobId: string; state: ResourceJob["state"]; error?: string }> {
		const { store, scope, services, policy } = this.options;
		signal.throwIfAborted();
		const job = store.indexing.get(scope(), id);
		if (job.state !== "pending") return { jobId: id, state: job.state };
		let claim: ResourceClaim | undefined;
		const defer = (
			error: string,
			state: "pending" | "unavailable" | "stale" = "unavailable",
		) => {
			store.indexing.defer(scope(), id, error, state);
			return { jobId: id, state, error };
		};
		const guard = () => {
			signal.throwIfAborted();
			if (
				!store.indexing.valid(scope(), job) ||
				canonical(resourceGeneration(services(), policy(), job.kind)) !==
					canonical(job.generation)
			)
				throw Error("source_or_configuration_changed");
		};
		try {
			guard();
			const settings = policy(),
				svc = services();
			if (job.kind === "extract") {
				const source = store.read(scope(), job.resourceId),
					mime = source.version.mediaType;
				if (source.bytes.length > store.limits.maxExtractionBytes)
					return defer("input_limit");
				if (
					!isResourceText(mime) &&
					!isResourceHtml(mime) &&
					!isDocumentMime(mime) &&
					!isImageMime(mime)
				)
					return defer("unsupported_type");
				if (
					isImageMime(mime) &&
					(!settings.resources.enabled || !svc.analyzeImage)
				)
					return defer(
						settings.resources.enabled
							? "vision_unavailable"
							: "policy_disabled",
					);
				const prepare = () => {
					guard();
					if (!claim)
						claim = store.indexing.prepare(
							scope(),
							id,
							hash({
								refs: job.refs,
								hash: source.version.hash,
								mediaType: mime,
							}),
						);
				};
				if (!isImageMime(mime)) prepare();
				const result = await extractResource(
					store,
					scope,
					job.resourceId,
					signal,
					{
						beforeDispatch: prepare,
						visionOutputTokens: settings.resources.outputTokens,
						...(svc.analyzeImage
							? {
									vision: async (input, sig, before, maxTokens) =>
										(await svc.analyzeImage?.(input, sig, before, maxTokens))
											?.text ?? null,
								}
							: {}),
					},
				);
				if (result.status === "unavailable") {
					if (claim) {
						store.indexing.fail(claim, result.reason);
						return { jobId: id, state: "unavailable", error: result.reason };
					}
					return defer(result.reason);
				}
				if (!claim) return defer("dispatch_guard_missing");
				guard();
				if (
					isImageMime(mime) &&
					(!result.text.isWellFormed() ||
						resourceEstimator(svc).text(result.text) >
							settings.resources.outputTokens)
				)
					throw Error("invalid_output");
				const accepted = store.indexing.complete(
					scope(),
					claim,
					result.text,
					result.complete,
				);
				return { jobId: id, state: accepted ? "ready" : "stale" };
			}
			if (!settings.resources.enabled) return defer("policy_disabled");
			if (!svc.summarizeResource) return defer("provider_unconfigured");
			const frames = this.frames(job, settings.resources.maxVisits);
			if (job.kind === "brief" && !frames[0]?.derivedId)
				return defer("dependency_not_ready", "pending");
			const digest = hash(frames),
				input = pack(frames, settings.resources, svc);
			const before = () => {
				guard();
				if (hash(this.frames(job, settings.resources.maxVisits)) !== digest)
					throw Error("source_or_configuration_changed");
				if (!claim)
					claim = store.indexing.prepare(
						scope(),
						id,
						hash({ text: input.text, framesDigest: digest }),
					);
			};
			const output = await svc.summarizeResource(
				input.text,
				signal,
				before,
				undefined,
				settings.resources.outputTokens,
				settings.resources.inputTokens,
			);
			if (!claim) return defer("dispatch_guard_missing");
			guard();
			if (hash(this.frames(job, settings.resources.maxVisits)) !== digest)
				throw Error("source_or_configuration_changed");
			if (
				!output.trim() ||
				!output.isWellFormed() ||
				resourceEstimator(svc).text(output) > settings.resources.outputTokens
			)
				throw Error("invalid_output");
			const accepted = store.indexing.complete(
				scope(),
				claim,
				output,
				input.complete && frames.length === job.refs.length,
			);
			return { jobId: id, state: accepted ? "ready" : "stale" };
		} catch (error) {
			if (!claim) {
				try {
					const saved = store.indexing.get(scope(), id);
					if (saved.state !== "pending")
						return {
							jobId: id,
							state: saved.state,
							...(saved.error ? { error: saved.error } : {}),
						};
				} catch {
					/* The new scope may no longer read this job. */
				}
			}
			const reason = signal.aborted
				? "cancelled"
				: error instanceof Error &&
						[
							"source_or_configuration_changed",
							"input_budget_insufficient",
							"resource_input_overhead_unavailable",
							"invalid_output",
						].includes(error.message)
					? error.message
					: "provider_failed";
			if (claim) {
				try {
					store.indexing.fail(
						claim,
						reason === "cancelled"
							? "cancelled"
							: reason === "source_or_configuration_changed"
								? "configuration_changed"
								: reason === "invalid_output"
									? "invalid_output"
									: "provider_failed",
					);
				} catch {
					return {
						jobId: id,
						state: "unknown",
						error: "claim_outcome_unknown",
					};
				}
				return { jobId: id, state: "failed", error: reason };
			}
			try {
				return defer(
					reason,
					reason === "source_or_configuration_changed"
						? "stale"
						: "unavailable",
				);
			} catch {
				try {
					const saved = store.indexing.get(scope(), id);
					return {
						jobId: id,
						state: saved.state,
						...(saved.error ? { error: saved.error } : {}),
					};
				} catch {
					return { jobId: id, state: "stale", error: reason };
				}
			}
		}
	}
}
