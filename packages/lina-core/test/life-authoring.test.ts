import { expect, test } from "bun:test";
import { importWorldData, worldReadiness } from "../src/world/authoring.ts";
import type { LifeConfigInput } from "../src/world/authoring-types.ts";
import {
	parseEvaluationInput,
	parseEvaluationLimits,
	parseLifeConfigInput,
	parseWorldConfirmation,
	parseWorldDraftCursor,
	parseWorldDraftInput,
	parseWorldDraftPatch,
	parseWorldPack,
	parseWorldPreviewOptions,
	parseWorldSuggestionRequest,
} from "../src/world/authoring-validation.ts";
import {
	authoringPack,
	evaluation,
	loreEntry,
	rule,
	unconfigured,
} from "./life-authoring-fixture.ts";
import { required } from "./life-fixture.ts";

test("strict pack rejects unknown fields, opcodes, nested types and lossy JSON without executing getters", () => {
	expect(parseWorldPack(authoringPack()).worldId).toBe("test-world");
	const bad: unknown[] = [
		{ ...authoringPack(), script: "evil" },
		{ ...authoringPack(), schemaVersion: 2 },
		{
			...authoringPack(),
			rules: [rule("r", { condition: { op: "literal", value: 1 } })],
		},
		{
			...authoringPack(),
			lore: [{ ...loreEntry("a"), condition: { op: "lua", code: "evil" } }],
		},
	];
	for (const input of bad) expect(() => parseWorldPack(input)).toThrow();
	let invoked = false;
	expect(() =>
		parseWorldPack({
			get schemaVersion() {
				invoked = true;
				return 1;
			},
		}),
	).toThrow();
	expect(invoked).toBe(false);
	for (const value of [Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
		expect(() =>
			parseWorldPack({ ...authoringPack(), version: value }),
		).toThrow();
});
test("pack links IDs and references without equating world version with LIFE revision", () => {
	const p = authoringPack();
	p.version = p.world.version = 7;
	expect(parseWorldPack(p).life.revision).toBe(1);
	for (const change of [
		(p: ReturnType<typeof authoringPack>) => {
			p.life.worldId = "wrong";
		},
		(p: ReturnType<typeof authoringPack>) => {
			required(p.roles[0]).agentId = "ghost";
		},
		(p: ReturnType<typeof authoringPack>) => {
			p.rules = [rule("same"), rule("same")];
		},
		(p: ReturnType<typeof authoringPack>) => {
			required(p.variables[0]).knownTo = ["ghost"];
		},
	]) {
		const p = authoringPack();
		change(p);
		expect(() => parseWorldPack(p)).toThrow();
	}
});
test("nullable operational config remains unconfigured; every configured group is strict", () => {
	expect(parseLifeConfigInput(unconfigured())).toEqual(unconfigured());
	const config = {
		...unconfigured(),
		clock: { stepSize: 1, intervalMs: null, maxCatchUpSteps: 0 },
		run: { mode: "manual" },
		models: {
			director: null,
			actor: { provider: "example", model: "example" },
		},
		limits: {
			maxActorActions: 0,
			maxCausalDepth: 0,
			maxModelCalls: 0,
			evaluation: evaluation().limits,
		},
		usage: { windowMs: 1, maxInputTokens: 0, maxOutputTokens: 0, maxImages: 0 },
		publication: { mode: "manual", recipientIds: [] },
		images: { mode: "manual", maxPerStep: 0 },
		avatars: { mode: "manual", intervalMs: null, maxPerWindow: 0 },
	} satisfies LifeConfigInput;
	expect(parseLifeConfigInput(config)).toEqual(config);
	for (const patch of [
		{ run: { mode: "guess" } },
		{ clock: { stepSize: 0, intervalMs: null, maxCatchUpSteps: 0 } },
		{ usage: { ...config.usage, maxImages: -1 } },
		{ images: { mode: "manual", maxPerStep: 1, execute: true } },
		{ version: 2 },
	])
		expect(() => parseLifeConfigInput({ ...config, ...patch })).toThrow();
});
test("strict draft, preview, confirmation, cursor and suggestion boundaries", () => {
	expect(
		parseWorldDraftInput({ worldId: "test-world", authoredText: "Era only" })
			.authoredText,
	).toBe("Era only");
	expect(
		parseWorldDraftPatch({ authoredText: "Era only", pack: null }).pack,
	).toBeNull();
	const options = {
		expectedWorldRevision: null,
		simulationTime: 0,
		agentId: "lina",
		targetAgentId: null,
		seed: "preview",
		limits: evaluation().limits,
		relocations: [{ agentId: "lina", sceneId: null }],
	};
	expect(parseWorldPreviewOptions(options)).toEqual(options);
	const confirmation = {
		draftId: "draft",
		expectedRevision: 1,
		idempotencyKey: "confirm",
		packDigest: "a".repeat(64),
		previewDigest: "b".repeat(64),
		options,
	};
	expect(parseWorldConfirmation(confirmation)).toEqual(confirmation);
	const suggestion = {
		requestId: "request",
		draftId: "draft",
		draftRevision: 1,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	expect(parseWorldSuggestionRequest(suggestion)).toEqual(suggestion);
	expect(parseWorldDraftCursor({ afterId: null, limit: 1 })).toEqual({
		afterId: null,
		limit: 1,
	});
	for (const [parse, value] of [
		[parseWorldDraftInput, { worldId: "test-world", authoredText: "" }],
		[parseWorldDraftPatch, { authoredText: "x", pack: null }],
		[parseWorldPreviewOptions, options],
		[parseWorldConfirmation, confirmation],
		[parseWorldSuggestionRequest, suggestion],
		[parseWorldDraftCursor, { afterId: null, limit: 1 }],
	] as const)
		expect(() => parse({ ...value, extra: true })).toThrow();
	expect(() => parseWorldDraftCursor({ afterId: null, limit: 4097 })).toThrow();
	expect(() =>
		parseWorldPreviewOptions({
			...options,
			relocations: [...options.relocations, ...options.relocations],
		}),
	).toThrow();
	expect(() =>
		parseWorldConfirmation({ ...confirmation, packDigest: "bad" }),
	).toThrow();
});
test("evaluation input and limits reject unbounded, missing and unknown state", () => {
	expect(parseEvaluationInput(evaluation())).toEqual(evaluation());
	for (const patch of [
		{ maxDepth: -1 },
		{ maxDepth: 1000000 },
		{ maxOperations: 0 },
		{ maxChars: 0 },
		{ maxRecords: 4097 },
		{ maxOperations: Infinity },
	])
		expect(() =>
			parseEvaluationLimits({ ...evaluation().limits, ...patch }),
		).toThrow();
	expect(() =>
		parseEvaluationInput({ ...evaluation(), variables: { count: NaN } }),
	).toThrow();
	expect(() =>
		parseEvaluationInput({ ...evaluation(), omniscient: "secret" }),
	).toThrow();
});
test("mixed Lina subset imports retain source IDs and report scripts as inert bounded JSON", () => {
	const supported = loreEntry("supported");
	const malicious = {
		id: "evil",
		op: "script",
		code: "globalThis.compromised = true",
		persona: { replace: "identity" },
	};
	const imported = importWorldData({
		lore: [supported, malicious],
		rules: [rule("r"), { id: "lua", op: "lua" }],
		network: { url: "https://invalid.example" },
	});
	expect(imported.lore).toEqual([supported]);
	expect(imported.rules).toEqual([rule("r")]);
	expect(imported.report.map((x) => x.sourceId)).toEqual([
		"evil",
		"lua",
		"network",
	]);
	expect(imported.report[0]?.rawJson).toContain("globalThis.compromised");
	expect(() =>
		importWorldData({ lore: [], rules: [], big: "x".repeat(1000001) }),
	).toThrow();
	let called = false;
	expect(() =>
		importWorldData({
			get lore() {
				called = true;
				return [];
			},
		}),
	).toThrow();
	expect(called).toBe(false);
});
test("readiness preserves unresolved decisions and never invents a world or config", () => {
	expect(worldReadiness(null).some((q) => q.blocking)).toBe(true);
	const p = authoringPack();
	p.unresolved = [{ id: "choice", question: "Which era?", blocking: false }];
	expect(worldReadiness(p)).toEqual(p.unresolved);
	p.roles = p.roles.map((r) => ({ ...r, status: "retired" }));
	expect(worldReadiness(p).some((q) => q.blocking)).toBe(true);
});

test("derived readiness does not duplicate an author's question identifier", () => {
	const p = authoringPack();
	p.world.places = [];
	p.world.scenes = [];
	p.unresolved = [
		{ id: "places", question: "Choose the places", blocking: false },
	];
	const questions = worldReadiness(p);
	expect(new Set(questions.map((question) => question.id)).size).toBe(
		questions.length,
	);
	expect(questions).toContainEqual(required(p.unresolved[0]));
	expect(questions.some((question) => question.blocking)).toBe(true);
});

test("pack parsing preserves existing LIFE subsets and historical placement for main-owned migration", () => {
	const p = authoringPack();
	p.life.participants = ["lina"];
	required(p.roles[1]).status = "retired";
	const parsed = parseWorldPack(p);
	expect(parsed.life.participants).toEqual(["lina"]);
	expect(parsed.world.scenes[0]?.occupants).toEqual(["lina", "mira"]);
});

test("unknown executable opcodes never enter supported imported or packed nodes", () => {
	const p = authoringPack();
	for (const op of [
		"script",
		"regex",
		"lua",
		"network",
		"model",
		"image",
		"persona_write",
		"loop",
		"call",
		"property",
	]) {
		const node = {
			...rule("unsupported"),
			effects: [{ kind: op, payload: "untrusted" }],
		};
		expect(() => parseWorldPack({ ...p, rules: [node] })).toThrow(
			"Unsupported",
		);
		const imported = importWorldData({ rules: [rule("valid"), node] });
		expect(imported.rules.map((r) => r.id)).toEqual(["valid"]);
		expect(imported.report).toHaveLength(1);
	}
});
