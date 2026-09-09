import type { ImageCountRecord } from "./image-accounting-types.ts";
import {
	parseImageCount,
	parseImageOutput,
	parseImageSettlement,
} from "./image-accounting-validation.ts";
import type {
	ImageAttemptDelivery,
	ImageAttemptObservation,
	ImageAttemptOperation,
	LifeImageAttempt,
	PrepareImageAttemptInput,
	RetryImageAttemptInput,
} from "./image-attempt-types.ts";
import type { LifeImageIntent } from "./image-types.ts";
import {
	digest,
	enumeration,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export function imageAttemptUuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
			value,
		)
	)
		throw Error("Invalid image attempt UUID");
	return value;
}
function bounded(value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw Error("Invalid image attempt text");
	return value;
}
export function parseAttemptRequest(
	value: unknown,
	retry: false,
): PrepareImageAttemptInput;
export function parseAttemptRequest(
	value: unknown,
	retry: true,
): RetryImageAttemptInput;
export function parseAttemptRequest(
	value: unknown,
	retry: boolean,
): PrepareImageAttemptInput | RetryImageAttemptInput {
	jsonBoundary(value);
	fields(
		value,
		retry
			? [
					"owner",
					"intentId",
					"briefDigest",
					"requestKey",
					"route",
					"previousAttemptId",
				]
			: ["owner", "intentId", "briefDigest", "requestKey", "route"],
	);
	fields(value.owner, ["kind", "worldId", "agentId"]);
	if (value.owner.kind !== "life")
		throw Error("Image attempt requires LIFE owner");
	fields(value.route, ["provider", "model", "settingsRevision"]);
	const request: PrepareImageAttemptInput = {
		owner: {
			kind: "life",
			worldId: identifier(value.owner.worldId),
			agentId: identifier(value.owner.agentId),
		},
		intentId: identifier(value.intentId),
		briefDigest: digest(value.briefDigest),
		requestKey: identifier(value.requestKey),
		route: {
			provider: bounded(value.route.provider, 128),
			model: bounded(value.route.model, 256),
			settingsRevision: revision(value.route.settingsRevision, 1),
		},
	};
	return retry
		? { ...request, previousAttemptId: identifier(value.previousAttemptId) }
		: request;
}
export function parseAttemptObservation(
	value: unknown,
): ImageAttemptObservation {
	jsonBoundary(value);
	fields(value, [
		"jobId",
		"state",
		"endpoint",
		"runtimeVersion",
		"resultFilename",
		"artifact",
		"error",
	]);
	const result: ImageAttemptObservation = {
		jobId: imageAttemptUuid(value.jobId),
		state: enumeration(value.state, [
			"prepared",
			"submitting",
			"queued",
			"running",
			"post_processing",
			"uncertain",
			"cancelling",
			"completed",
			"failed",
			"cancelled",
		]),
		endpoint: value.endpoint === null ? null : bounded(value.endpoint, 2048),
		runtimeVersion:
			value.runtimeVersion === null ? null : bounded(value.runtimeVersion, 128),
		resultFilename: null,
		artifact: value.artifact === null ? null : parseImageOutput(value.artifact),
		error: value.error === null ? null : bounded(value.error, 512),
	};
	if (value.resultFilename !== null) {
		const settlement = parseImageSettlement({
			kind: "result",
			resultFilename: value.resultFilename,
		});
		if (settlement.kind !== "result") throw Error("Invalid image result");
		result.resultFilename = settlement.resultFilename;
	}
	if (result.endpoint !== null) {
		const url = new URL(result.endpoint);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.hash ||
			url.search
		)
			throw Error("Invalid image endpoint");
	}
	if ((result.endpoint === null) !== (result.runtimeVersion === null))
		throw Error("Incomplete image endpoint/version provenance");
	if (result.state === "prepared" && result.endpoint !== null)
		throw Error("Prepared image has dispatch provenance");
	if ((result.state === "completed") !== (result.artifact !== null))
		throw Error("Image completion requires imported artifact");
	if (result.artifact && result.artifact.id !== result.jobId)
		throw Error("Image artifact UUID conflict");
	if (
		(result.artifact || result.resultFilename) &&
		(!result.resultFilename || !result.endpoint)
	)
		throw Error("Missing image result provenance");
	return result;
}
export function parseAttemptDelivery(value: unknown): ImageAttemptDelivery {
	jsonBoundary(value);
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid image delivery");
	if (value.kind === "pending") {
		fields(value, ["kind"]);
		return { kind: "pending" };
	}
	if (value.kind === "post") {
		fields(value, [
			"kind",
			"receiptId",
			"postId",
			"postRevision",
			"artifactId",
		]);
		return {
			kind: "post",
			receiptId: identifier(value.receiptId),
			postId: identifier(value.postId),
			postRevision: revision(value.postRevision, 1),
			artifactId: imageAttemptUuid(value.artifactId),
		};
	}
	fields(value, [
		"kind",
		"receiptId",
		"candidateId",
		"applicationId",
		"avatarId",
		"profileRevision",
		"visualRevision",
		"artifactId",
	]);
	if (value.kind !== "avatar") throw Error("Invalid image delivery kind");
	return {
		kind: "avatar",
		receiptId: identifier(value.receiptId),
		candidateId: identifier(value.candidateId),
		applicationId: identifier(value.applicationId),
		avatarId: digest(value.avatarId),
		profileRevision: revision(value.profileRevision, 1),
		visualRevision: revision(value.visualRevision, 1),
		artifactId: imageAttemptUuid(value.artifactId),
	};
}
export function parseAttemptOperation(value: unknown): ImageAttemptOperation {
	jsonBoundary(value);
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid image attempt operation");
	switch (value.kind) {
		case "prepare":
			fields(value, ["kind", "request"]);
			return {
				kind: "prepare",
				request: parseAttemptRequest(value.request, false),
			};
		case "retry":
			fields(value, ["kind", "request", "evidence"]);
			return {
				kind: "retry",
				request: parseAttemptRequest(value.request, true),
				evidence: parseImageCount(value.evidence),
			};
		case "link":
			fields(value, ["kind", "jobId"]);
			return { kind: "link", jobId: imageAttemptUuid(value.jobId) };
		case "observe":
		case "recover":
			fields(value, ["kind", "observation"]);
			return {
				kind: value.kind,
				observation: parseAttemptObservation(value.observation),
			};
		case "acknowledge":
			fields(value, ["kind", "requestKey", "delivery"]);
			return {
				kind: "acknowledge",
				requestKey: identifier(value.requestKey),
				delivery: parseAttemptDelivery(value.delivery),
			};
		default:
			throw Error("Invalid image attempt operation kind");
	}
}
export function attemptRequestKey(
	operation: ImageAttemptOperation,
	attemptId: string,
): string {
	if (operation.kind === "prepare" || operation.kind === "retry")
		return lifeDigest({ requestKey: operation.request.requestKey });
	if (operation.kind === "acknowledge")
		return lifeDigest({ requestKey: operation.requestKey });
	return lifeDigest({ attemptId, operation });
}
export function attemptIdFor(
	worldId: string,
	intentId: string,
	attemptNumber: number,
): string {
	return `life-image-attempt-${lifeDigest({ worldId, intentId, attemptNumber })}`;
}
export function verifyAttemptIntent(
	attempt: LifeImageAttempt,
	intent: LifeImageIntent,
): void {
	if (
		lifeDigest(attempt.owner) !== lifeDigest(intent.owner) ||
		attempt.intentId !== intent.intentId ||
		attempt.intentDigest !== lifeDigest(intent) ||
		attempt.briefDigest !== intent.briefDigest
	)
		throw Error("Image attempt actual intent conflict");
}
export function verifyAttemptRequest(
	request: PrepareImageAttemptInput,
	intent: LifeImageIntent,
): void {
	if (
		lifeDigest(request.owner) !== lifeDigest(intent.owner) ||
		request.intentId !== intent.intentId ||
		request.briefDigest !== intent.briefDigest
	)
		throw Error("Image attempt intent/owner/brief conflict");
}
/** Event accounting stays with the accepted source step, even for a delayed explicit request. */
export function actualSourceLifeRevision(
	intent: Pick<LifeImageIntent, "source" | "createdLifeRevision">,
): number {
	return revision(
		intent.source.kind === "event_post" || intent.source.kind === "avatar_event"
			? intent.source.lifeRevision
			: intent.createdLifeRevision,
	);
}
export function verifyRetryOutcome(
	prior: LifeImageAttempt,
	evidence: ImageCountRecord,
	intent: LifeImageIntent,
): void {
	const observed = prior.observation;
	if (
		!prior.jobId ||
		!observed ||
		!["failed", "cancelled"].includes(observed.state)
	)
		throw Error("Image retry requires known terminal outcome");
	if (observed.resultFilename || observed.artifact)
		throw Error("Known image result requires artifact recovery");
	const binding = evidence.reservation.binding;
	if (
		lifeDigest(binding) !==
		lifeDigest({
			worldId: prior.owner.worldId,
			agentId: prior.owner.agentId,
			intentId: prior.intentId,
			attemptId: prior.attemptId,
			jobId: prior.jobId,
			kind: intent.source.kind === "event_post" ? "event" : "avatar",
			sourceLifeRevision: actualSourceLifeRevision(intent),
			settingsRevision: prior.route.settingsRevision,
			configRevision: intent.configRevision,
			frozenDigest: prior.briefDigest,
		})
	)
		throw Error("Image retry accounting binding conflict");
	const knownFailure =
		evidence.state === "attempted" &&
		evidence.terminal === "failed" &&
		evidence.dispatchAtMs !== null &&
		observed.endpoint !== null;
	const knownZero =
		evidence.state === "released" &&
		evidence.terminal === "no_post" &&
		evidence.dispatchAtMs === null;
	if ((!knownFailure && !knownZero) || evidence.resultFilename !== null)
		throw Error("Image retry lacks known accounting outcome");
}
function terminal(state: ImageAttemptObservation["state"]): boolean {
	return ["completed", "failed", "cancelled"].includes(state);
}
/** Deterministically replay retained operations; never consult current effect permission. */
export function advanceAttempt(
	prior: LifeImageAttempt,
	operation: ImageAttemptOperation,
	intent: LifeImageIntent,
): LifeImageAttempt {
	let next = { ...prior, revision: revision(prior.revision + 1, 1) };
	switch (operation.kind) {
		case "prepare":
			verifyAttemptRequest(operation.request, intent);
			if (lifeDigest(operation.request.route) !== lifeDigest(prior.route))
				throw Error("Original image route conflict");
			break;
		case "retry":
			throw Error("Retry must create a new image attempt");
		case "link":
			if (prior.jobId !== null && prior.jobId !== operation.jobId)
				throw Error("Image UUID link conflict");
			next = { ...next, jobId: operation.jobId };
			break;
		case "observe":
		case "recover": {
			const observation = operation.observation,
				old = prior.observation;
			if (prior.jobId !== observation.jobId)
				throw Error("Unlinked or conflicting image UUID");
			if (
				old?.endpoint !== null &&
				old?.endpoint !== undefined &&
				(old.endpoint !== observation.endpoint ||
					old.runtimeVersion !== observation.runtimeVersion)
			)
				throw Error("Original image endpoint/version conflict");
			if (
				old?.resultFilename &&
				old.resultFilename !== observation.resultFilename
			)
				throw Error("Original image result filename conflict");
			if (operation.kind === "recover") {
				if (
					old?.state !== "failed" ||
					!old.resultFilename ||
					observation.state !== "completed" ||
					observation.resultFilename !== old.resultFilename
				)
					throw Error("Image artifact recovery requires failed known result");
			} else if (old && terminal(old.state))
				throw Error("Terminal image observation cannot reopen generation");
			if (old && old.state !== "prepared" && observation.state === "prepared")
				throw Error("Image generation cannot return to prepared");
			next = { ...next, observation };
			break;
		}
		case "acknowledge": {
			const delivery = operation.delivery;
			if (
				prior.delivery.kind !== "pending" &&
				lifeDigest(prior.delivery) !== lifeDigest(delivery)
			)
				throw Error("Image delivery already acknowledged");
			if (delivery.kind !== "pending") {
				if (!prior.observation?.artifact || delivery.artifactId !== prior.jobId)
					throw Error("Image delivery requires original imported artifact");
				if (
					delivery.kind === "post"
						? intent.source.kind !== "event_post" ||
							delivery.postId !== intent.source.publicationId
						: intent.source.kind === "event_post"
				)
					throw Error("Image delivery destination conflict");
			}
			next = { ...next, delivery };
			break;
		}
	}
	return next;
}
