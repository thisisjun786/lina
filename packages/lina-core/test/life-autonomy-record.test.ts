import { expect, test } from "bun:test";
import {
	parseLifeModelRecord,
	parsePreparedLifeModel,
} from "../src/world/autonomy-record-validation.ts";
import { lifeDigest } from "../src/world/life-json.ts";

export function preparedModel() {
	const request = {
		version: 1,
		id: "model-1",
		worldId: "test-world",
		stepId: "step-1",
		lane: "actor",
		agentId: "lina",
		provider: "opencodex",
		model: "synthetic-actor",
		modelSettingsRevision: 3,
		systemPrompt: "Only the synthetic actor",
		input: "{}",
		limits: {
			maxInputTokens: 40,
			maxOutputTokens: 20,
			maxInputBytes: 4000,
			maxOutputBytes: 3000,
			timeoutMs: 1000,
		},
	};
	return {
		version: 1,
		request,
		inputDigest: lifeDigest(request),
		capabilityFingerprint: "a".repeat(64),
		nativeReference: "native-1",
	};
}

test("a model reservation remains uncertain until native usage is known", () => {
	const prepared = parsePreparedLifeModel(preparedModel());
	const record = {
		prepared,
		status: "unknown" as const,
		preparedAt: 100,
		dispatchedAt: 101,
		result: null,
		usage: { inputTokens: null, outputTokens: null, totalTokens: null },
		reservation: { inputTokens: 40, outputTokens: 20 },
		upstreamAttempts: null,
		error: "response_unknown",
	};
	expect(parseLifeModelRecord(record)).toEqual(record);
	expect(() =>
		parseLifeModelRecord({
			...record,
			usage: { inputTokens: -1, outputTokens: 4, totalTokens: 3 },
		}),
	).toThrow();
	expect(() =>
		parseLifeModelRecord({ ...record, status: "completed" }),
	).toThrow();
});

test("failed and in-flight records cannot fabricate dispatch or usage provenance", () => {
	const prepared = parsePreparedLifeModel(preparedModel());
	const base = {
		prepared,
		status: "failed",
		preparedAt: 100,
		dispatchedAt: 101,
		result: null,
		usage: { inputTokens: null, outputTokens: null, totalTokens: null },
		reservation: { inputTokens: 40, outputTokens: 20 },
		upstreamAttempts: 0,
		error: "transport_failure",
	};
	expect(() =>
		parseLifeModelRecord({ ...base, upstreamAttempts: null }),
	).toThrow();
	expect(() =>
		parseLifeModelRecord({
			...base,
			usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
		}),
	).toThrow();
	expect(() =>
		parseLifeModelRecord({ ...base, dispatchedAt: null, upstreamAttempts: 1 }),
	).toThrow();
	expect(() =>
		parseLifeModelRecord({
			...base,
			status: "dispatched",
			upstreamAttempts: 1,
			error: null,
		}),
	).toThrow();
});

test("prepared request identity and input cannot be changed under the old digest", () => {
	const prepared = preparedModel();
	expect(parsePreparedLifeModel(prepared).inputDigest).toBe(
		prepared.inputDigest,
	);
	expect(() =>
		parsePreparedLifeModel({
			...prepared,
			request: { ...prepared.request, agentId: "mira" },
		}),
	).toThrow();
	expect(() =>
		parsePreparedLifeModel({ ...prepared, command: "/bin/sh" }),
	).toThrow();
});

test("existing routed model names remain valid in prepared receipts", () => {
	const prepared = preparedModel();
	prepared.request.model = "anthropic/claude-fable-5-1";
	prepared.inputDigest = lifeDigest(prepared.request);
	expect(parsePreparedLifeModel(prepared).request.model).toBe(
		"anthropic/claude-fable-5-1",
	);
});
