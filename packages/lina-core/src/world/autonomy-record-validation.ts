import { authoringText } from "./authoring-node-validation.ts";
import type {
	LifeLease,
	LifeModelLimits,
	LifeModelRecord,
	LifeModelRequest,
	LifeModelResult,
	LifeModelUsage,
	LifeSchedule,
	PreparedLifeModelRequest,
} from "./autonomy-types.ts";
import {
	digest,
	enumeration,
	identifier,
	jsonBoundary,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { fields, integer, MAX_WORLD_BYTES } from "./validation.ts";

function one(value: unknown): 1 {
	if (value !== 1) throw Error("Unsupported autonomy record version");
	return 1;
}
function bounded(value: unknown, name: string, max: number): number {
	integer(value, name, 1, max);
	return value;
}
export function parseLifeModelLimits(value: unknown): LifeModelLimits {
	fields(value, [
		"maxInputTokens",
		"maxOutputTokens",
		"maxInputBytes",
		"maxOutputBytes",
		"timeoutMs",
	]);
	return {
		maxInputTokens: revision(value.maxInputTokens, 1),
		maxOutputTokens: revision(value.maxOutputTokens, 1),
		maxInputBytes: bounded(
			value.maxInputBytes,
			"model input bytes",
			MAX_WORLD_BYTES,
		),
		maxOutputBytes: bounded(
			value.maxOutputBytes,
			"model output bytes",
			MAX_WORLD_BYTES,
		),
		timeoutMs: bounded(value.timeoutMs, "model timeout", 300_000),
	};
}
export function parseLifeModelRequest(value: unknown): LifeModelRequest {
	jsonBoundary(value);
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		(value.version !== 1 && value.version !== 2)
	)
		throw Error("Unsupported LIFE model request version");
	const version = value.version;
	fields(value, [
		"version",
		"id",
		"worldId",
		...(version === 1 ? (["stepId"] as const) : (["jobId"] as const)),
		"lane",
		"agentId",
		"provider",
		"model",
		"modelSettingsRevision",
		"systemPrompt",
		"input",
		"limits",
	]);
	const result: LifeModelRequest = {
		...(version === 1
			? {
					version,
					id: identifier(value.id),
					worldId: identifier(value.worldId),
					stepId: identifier(value.stepId),
					lane: enumeration(value.lane, [
						"director",
						"actor",
						"target",
						"reflection",
					]),
				}
			: {
					version,
					id: identifier(value.id),
					worldId: identifier(value.worldId),
					jobId: identifier(value.jobId),
					lane: enumeration(value.lane, ["publication"]),
				}),
		agentId: identifier(value.agentId),
		provider: authoringText(value.provider),
		model: authoringText(value.model),
		modelSettingsRevision: revision(value.modelSettingsRevision),
		systemPrompt: authoringText(value.systemPrompt),
		input: authoringText(value.input),
		limits: parseLifeModelLimits(value.limits),
	};
	if (
		Buffer.byteLength(result.input) + Buffer.byteLength(result.systemPrompt) >
		result.limits.maxInputBytes
	)
		throw Error("LIFE model input exceeds byte limit");
	return result;
}
export function parsePreparedLifeModel(
	value: unknown,
): PreparedLifeModelRequest {
	jsonBoundary(value);
	fields(value, [
		"version",
		"request",
		"inputDigest",
		"capabilityFingerprint",
		"nativeReference",
	]);
	const result = {
		version: one(value.version),
		request: parseLifeModelRequest(value.request),
		inputDigest: digest(value.inputDigest),
		capabilityFingerprint: digest(value.capabilityFingerprint),
		nativeReference: identifier(value.nativeReference),
	};
	if (result.inputDigest !== lifeDigest(result.request))
		throw Error("LIFE model input digest mismatch");
	return result;
}
export function parseLifeModelUsage(value: unknown): LifeModelUsage {
	fields(value, ["inputTokens", "outputTokens", "totalTokens"]);
	const result = {
		inputTokens:
			value.inputTokens === null ? null : revision(value.inputTokens),
		outputTokens:
			value.outputTokens === null ? null : revision(value.outputTokens),
		totalTokens:
			value.totalTokens === null ? null : revision(value.totalTokens),
	};
	if (
		result.inputTokens !== null &&
		result.outputTokens !== null &&
		result.totalTokens !== null &&
		result.inputTokens + result.outputTokens !== result.totalTokens
	)
		throw Error("LIFE model usage totals disagree");
	return result;
}
export function parseLifeModelResult(
	value: unknown,
	prepared: PreparedLifeModelRequest,
): LifeModelResult {
	jsonBoundary(value);
	fields(value, [
		"version",
		"requestId",
		"inputDigest",
		"capabilityFingerprint",
		"nativeReference",
		"provider",
		"model",
		"threadId",
		"turnId",
		"text",
		"usage",
		"upstreamAttempts",
	]);
	const result: LifeModelResult = {
		version: one(value.version),
		requestId: identifier(value.requestId),
		inputDigest: digest(value.inputDigest),
		capabilityFingerprint: digest(value.capabilityFingerprint),
		nativeReference: identifier(value.nativeReference),
		provider: authoringText(value.provider),
		model: authoringText(value.model),
		threadId: identifier(value.threadId),
		turnId: identifier(value.turnId),
		text: authoringText(value.text, true),
		usage: parseLifeModelUsage(value.usage),
		upstreamAttempts: one(value.upstreamAttempts),
	};
	if (
		result.requestId !== prepared.request.id ||
		result.inputDigest !== prepared.inputDigest ||
		result.capabilityFingerprint !== prepared.capabilityFingerprint ||
		result.nativeReference !== prepared.nativeReference ||
		result.provider !== prepared.request.provider ||
		result.model !== prepared.request.model
	)
		throw Error("LIFE model result ownership mismatch");
	if (Buffer.byteLength(result.text) > prepared.request.limits.maxOutputBytes)
		throw Error("LIFE model result exceeds byte limit");
	return result;
}
export function parseLifeModelRecord(value: unknown): LifeModelRecord {
	jsonBoundary(value);
	fields(value, [
		"prepared",
		"status",
		"preparedAt",
		"dispatchedAt",
		"result",
		"usage",
		"reservation",
		"upstreamAttempts",
		"error",
	]);
	fields(value.reservation, ["inputTokens", "outputTokens"]);
	const prepared = parsePreparedLifeModel(value.prepared);
	const attempts =
		value.upstreamAttempts === null ? null : revision(value.upstreamAttempts);
	if (attempts !== null && attempts !== 0 && attempts !== 1)
		throw Error("Invalid LIFE provider attempt count");
	const record: LifeModelRecord = {
		prepared,
		status: enumeration(value.status, [
			"prepared",
			"dispatched",
			"completed",
			"unknown",
			"failed",
		]),
		preparedAt: revision(value.preparedAt),
		dispatchedAt:
			value.dispatchedAt === null ? null : revision(value.dispatchedAt),
		result:
			value.result === null
				? null
				: parseLifeModelResult(value.result, prepared),
		usage: parseLifeModelUsage(value.usage),
		reservation: {
			inputTokens: revision(value.reservation.inputTokens),
			outputTokens: revision(value.reservation.outputTokens),
		},
		upstreamAttempts: attempts,
		error: value.error === null ? null : authoringText(value.error),
	};
	if (
		record.reservation.inputTokens !== prepared.request.limits.maxInputTokens ||
		record.reservation.outputTokens !==
			prepared.request.limits.maxOutputTokens ||
		(record.dispatchedAt !== null && record.dispatchedAt < record.preparedAt)
	)
		throw Error("Corrupt LIFE model reservation or dispatch time");
	const unknownUsage = Object.values(record.usage).every((v) => v === null);
	if (
		record.status === "prepared" &&
		(record.dispatchedAt !== null ||
			record.result !== null ||
			record.upstreamAttempts !== 0 ||
			!unknownUsage ||
			record.error !== null)
	)
		throw Error("Invalid prepared LIFE model record");
	if (
		["dispatched", "unknown", "completed"].includes(record.status) &&
		record.dispatchedAt === null
	)
		throw Error("LIFE model record lacks dispatch provenance");
	if (record.status === "completed") {
		if (
			!record.result ||
			record.upstreamAttempts !== 1 ||
			record.error !== null ||
			lifeDigest(record.usage) !== lifeDigest(record.result.usage)
		)
			throw Error("Incomplete LIFE model result record");
	} else if (record.result !== null)
		throw Error("Unexpected LIFE model result");
	if (record.status === "failed" && record.error === null)
		throw Error("Missing LIFE model failure reason");
	if (
		record.status === "dispatched" &&
		(!unknownUsage || record.upstreamAttempts !== null)
	)
		throw Error("Unresolved LIFE model has fabricated usage provenance");
	if (record.status === "unknown") {
		if (!unknownUsage && record.upstreamAttempts !== 1)
			throw Error("Uncertain LIFE usage lacks outbound proof");
	}
	if (record.status === "failed") {
		if (
			record.upstreamAttempts === null ||
			(record.dispatchedAt === null && record.upstreamAttempts !== 0)
		)
			throw Error("Failed LIFE model lacks dispatch provenance");
		if (
			record.upstreamAttempts === 0 &&
			Object.values(record.usage).some((value) => value !== null && value !== 0)
		)
			throw Error("Undispatched LIFE model cannot have observed usage");
	}
	return record;
}
export function parseLifeLease(value: unknown): LifeLease {
	fields(value, ["worldId", "owner", "generation", "token", "expiresAt"]);
	return {
		worldId: identifier(value.worldId),
		owner: identifier(value.owner),
		generation: revision(value.generation, 1),
		token: revision(value.token, 1),
		expiresAt: revision(value.expiresAt, 1),
	};
}
export function parseLifeSchedule(value: unknown): LifeSchedule {
	jsonBoundary(value);
	fields(value, [
		"worldId",
		"generation",
		"configRevision",
		"lease",
		"nextDue",
		"lastStepId",
		"lastClock",
		"leaseSequence",
		"lastSkippedIntervals",
	]);
	const schedule: LifeSchedule = {
		worldId: identifier(value.worldId),
		generation: revision(value.generation, 1),
		configRevision: revision(value.configRevision),
		lease: value.lease === null ? null : parseLifeLease(value.lease),
		nextDue: value.nextDue === null ? null : revision(value.nextDue),
		lastStepId: nullableId(value.lastStepId),
		lastClock: revision(value.lastClock),
		leaseSequence: revision(value.leaseSequence),
		lastSkippedIntervals: revision(value.lastSkippedIntervals),
	};
	if (
		schedule.lease &&
		(schedule.lease.worldId !== schedule.worldId ||
			schedule.lease.generation !== schedule.generation ||
			schedule.lease.token !== schedule.leaseSequence)
	)
		throw Error("Corrupt LIFE lease identity");
	return schedule;
}
