import { expect, test } from "bun:test";
import { canonicalLifeJson } from "../src/world/life-json.ts";
import {
	publicationNarrationMaterial,
	selectPublicationMaterial,
} from "../src/world/publication-material.ts";
import { parsePublicationSettings } from "../src/world/publication-validation.ts";
import { socialCommit } from "./life-fixture.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

const legacy = {
	version: 1 as const,
	agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
	reactionIds: [],
	maxChainDepth: 8,
	maxActionsPerChain: 10,
	perAuthorCooldownSteps: 0,
	maxJobsPerRun: 1,
};
const configured = {
	...legacy,
	version: 2 as const,
	worldVersion: 1,
	eventRules: [
		{
			familyId: "meeting",
			authorAgentIds: ["lina"],
			recipientIds: ["friends"],
			summary: "Two residents met.",
		},
	],
};

test("explicit future-event rules preserve the exact v1 settings shape and require v2", () => {
	expect(canonicalLifeJson(parsePublicationSettings(legacy))).toBe(
		canonicalLifeJson(legacy),
	);
	expect(parsePublicationSettings(configured)).toEqual(configured);
	expect(parsePublicationSettings({ ...configured, eventRules: [] })).toEqual({
		...configured,
		eventRules: [],
	});
	expect(() =>
		parsePublicationSettings({ ...configured, version: 1 }),
	).toThrow();
	expect(() => parsePublicationSettings({ ...legacy, version: 2 })).toThrow();
});

test("future-event rules reject duplicate families, malformed summaries and hidden extensions", () => {
	const rule = configured.eventRules[0];
	if (!rule) throw Error("Missing rule");
	for (const eventRules of [
		[rule, rule],
		[{ ...rule, authorAgentIds: ["lina", "lina"] }],
		[{ ...rule, recipientIds: ["friends", "friends"] }],
		[{ ...rule, summary: { prompt: "read private memory" } }],
		[{ ...rule, includePrivateSummary: true }],
	])
		expect(() =>
			parsePublicationSettings({ ...configured, eventRules }),
		).toThrow();
});

function materialInput() {
	const store = publicationStoreFixture();
	try {
		const intent = store.lifeEffects("test-world")[0];
		if (!intent) throw Error("Missing intent");
		const policy = store.lifeDefinition("test-world").projection;
		policy.disclosures = [];
		return {
			world: store.snapshot("test-world"),
			life: store.lifeSnapshot("test-world"),
			event: {
				...socialCommit().world,
				id: "test-world:1",
				revision: 1,
				acceptedAt: "synthetic",
				origin: "fictional" as const,
				definitionVersion: 1,
			},
			intent,
			policy,
			authorAgentId: "lina",
			recipientIds: ["friends"],
			definitionRevision: 1,
			workRevision: 0,
			workAncestryRevision: 0,
			configRevision: 1,
			settingsRevision: 1,
			workEvidenceDigest: "a".repeat(64),
			limits: { maxChars: 400, maxRecords: 10 },
			workAllowed: () => true,
			eventRules: { familyId: "meeting", rules: configured.eventRules },
		};
	} finally {
		store.close();
	}
}

test("future summary substitution precedes limits and makes private summary text and length irrelevant", () => {
	const input = materialInput();
	const original = JSON.stringify(input);
	const selected = selectPublicationMaterial(input);
	expect(selected).not.toBeNull();
	const changed = structuredClone({ ...input, workAllowed: undefined });
	changed.event.summary = "PRIVATE_SUMMARY_".repeat(1000);
	const second = selectPublicationMaterial({
		...changed,
		workAllowed: input.workAllowed,
	});
	expect(second).toEqual(selected);
	if (!selected) throw Error("Missing permitted event");
	expect(
		publicationNarrationMaterial(selected).claims.map((claim) => claim.text),
	).toEqual(["Two residents met."]);
	expect(JSON.stringify(input)).toBe(original);
	const oversized = materialInput();
	oversized.eventRules = {
		familyId: "meeting",
		rules: configured.eventRules.map((rule) => ({
			...rule,
			summary: "public ".repeat(100),
		})),
	};
	expect(selectPublicationMaterial(oversized)).toBeNull();
});

test("future rules do not grant event knowledge, unrelated family access, extra facts or work consent", () => {
	const input = materialInput();
	expect(
		selectPublicationMaterial({
			...input,
			eventRules: { ...input.eventRules, familyId: "elsewhere" },
		}),
	).toBeNull();
	expect(
		selectPublicationMaterial({ ...input, eventRules: undefined }),
	).toBeNull();
	expect(
		selectPublicationMaterial({ ...input, workAllowed: () => false }),
	).toBeNull();
	const unknown = materialInput();
	unknown.event.audience = ["mira"];
	unknown.life.experiences = [
		{
			id: "inferred-only",
			agentId: "lina",
			eventId: unknown.event.id,
			channel: "inferred",
			claims: [],
			simulationTime: unknown.event.simulationTime,
		},
	];
	expect(selectPublicationMaterial(unknown)).toBeNull();
	expect(
		selectPublicationMaterial({ ...input, recipientIds: ["public"] }),
	).toBeNull();
	const selected = selectPublicationMaterial(input);
	expect(JSON.stringify(selected)).not.toContain("hidden key");
	expect(JSON.stringify(selected)).not.toContain("whispered");
});

test("exact-event raw permission stays explicit and incompatible recipient summaries have no common material", () => {
	const input = materialInput();
	input.policy.disclosures.push({
		subject: { kind: "world_event", id: input.event.id },
		policy: {
			knowers: ["lina"],
			disclosures: [{ agentId: "lina", recipientId: "friends" }],
			publication: ["friends"],
		},
	});
	expect(selectPublicationMaterial(input)?.allowedClaims[0]?.text).toBe(
		input.event.summary,
	);
	input.recipientIds = ["friends", "public"];
	input.eventRules.rules = configured.eventRules.map((rule) => ({
		...rule,
		recipientIds: ["public"],
	}));
	expect(selectPublicationMaterial(input)).toBeNull();
});
