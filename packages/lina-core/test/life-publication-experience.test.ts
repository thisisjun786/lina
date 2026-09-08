import { expect, test } from "bun:test";
import {
	buildAutonomyOutcome,
	prepareAutonomyObservation,
} from "../src/world/autonomy-transition.ts";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import type { LifeInputV3 } from "../src/world/life-types.ts";
import { freezePublicationBudget } from "../src/world/publication-budget.ts";
import {
	type PublicationInteractionAction,
	publicationObservationId,
} from "../src/world/publication-input.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function feedback(
	action: PublicationInteractionAction = {
		kind: "reply",
		text: "A claim from a reader, not a verified world fact.",
	},
) {
	const f = autonomyStoreFixture();
	const settings = f.store.setPublicationSettings(f.request.worldId, 0, {
		version: 1,
		agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
		reactionIds: ["support"],
		maxChainDepth: 8,
		maxActionsPerChain: 10,
		perAuthorCooldownSteps: 0,
		maxJobsPerRun: 1,
	});
	const prior = f.store.prepareLifeStep(f.request, () => 1);
	const id = publicationObservationId(prior.worldId, "interaction", "lina");
	const source: LifeInputV3["source"] = {
		kind: "publication_interaction",
		observationId: id,
		interactionId: "interaction",
		postId: "private-post-reference",
		postRevision: 1,
		principal: { kind: "viewer", grantId: "private-grant-reference" },
		recipientAgentId: "lina",
		action,
		roots: [{ rootId: "private-root-reference", depth: 1 }],
	};
	const input: LifeInputV3 = {
		version: 3,
		worldId: prior.worldId,
		id,
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
	const step: LifeStep = {
		...prior,
		version: 3,
		source: {
			...prior.source,
			inputs: [input],
			publicationAncestry: [],
			publication: {
				version: 1,
				worldId: prior.worldId,
				revision: 1,
				permissionDigest: lifeDigest({ scope: "synthetic-permitted" }),
				authority: { settingsRevision: 1, posts: [], grants: [] },
				records: [{ inputId: id, source }],
			},
		},
	};
	if (!prior.source.publicationBudget) throw Error("Missing prepared budget");
	step.source.publicationBudget = freezePublicationBudget(
		step.source,
		prior.source.publicationBudget.chain,
		settings,
	);
	return { step, input, close: f.close };
}

test("only the receiving agent gets pending typed feedback in its intention input, without grant/post control data", () => {
	const f = feedback();
	try {
		f.step.decision = { ...f.step.decision, agentId: "lina" };
		const own = buildLifeModelInput(f.step, "director", "lina");
		expect(JSON.parse(own.input).publicationFeedback).toEqual([
			{ from: { kind: "viewer" }, action: f.input.source.action },
		]);
		for (const secret of [
			"private-grant-reference",
			"private-post-reference",
			"private-root-reference",
		])
			expect(own.input).not.toContain(secret);
		f.step.reflectionAgentIds = ["mira"];
		const other = buildLifeModelInput(f.step, "reflection", "mira");
		expect(other.input).not.toContain("A claim from a reader");
		expect(JSON.parse(other.input)).not.toHaveProperty("publicationFeedback");
	} finally {
		f.close();
	}
});

test("permitted quiet feedback becomes one private told experience without treating a reader's claim as truth or changing identity", () => {
	const f = feedback();
	try {
		const before = structuredClone(f.step);
		const outcome = buildAutonomyOutcome(f.step, null);
		expect(outcome.kind).toBe("feedback");
		expect(outcome.commit.consumedInputIds).toEqual([f.input.id]);
		expect(outcome.commit.experiences).toHaveLength(1);
		expect(outcome.commit.experiences[0]).toMatchObject({
			agentId: "lina",
			channel: "told",
		});
		expect(outcome.commit.claims[0]).toMatchObject({
			truth: "unknown",
			disclosure: { knowers: ["lina"], disclosures: [], publication: [] },
		});
		expect(outcome.commit.claims[0]?.text).toContain("A claim from a reader");
		expect(outcome.commit.growth).toEqual([]);
		expect(outcome.commit.effects).toEqual([]);
		const staged = prepareAutonomyObservation(f.step, null);
		expect(staged.life.experiences).toEqual(outcome.commit.experiences);
		expect(f.step).toEqual(before);
	} finally {
		f.close();
	}
});

test.each([
	{ kind: "reply", text: "hello" },
	{ kind: "reaction", reactionId: "support", active: true },
	{ kind: "reaction", reactionId: "support", active: false },
	{ kind: "reshare" },
] satisfies PublicationInteractionAction[])(
	"typed $kind feedback keeps control and grant identifiers out of experience text",
	(action) => {
		const f = feedback(action);
		try {
			const claims = buildAutonomyOutcome(f.step, null).commit.claims;
			expect(claims).toHaveLength(1);
			const text = claims[0]?.text ?? "";
			expect(text.length).toBeGreaterThan(0);
			for (const secret of [
				"private-post-reference",
				"private-grant-reference",
				"private-root-reference",
			])
				expect(text).not.toContain(secret);
		} finally {
			f.close();
		}
	},
);

test("consumed or currently ineligible feedback cannot produce or consume another experience", () => {
	const f = feedback();
	try {
		f.input.consumedLifeRevision = 1;
		expect(buildAutonomyOutcome(f.step, null).commit.experiences).toEqual([]);
		f.input.consumedLifeRevision = null;
		if (!f.step.source.publication) throw Error("fixture evidence missing");
		f.step.source.publication.records = [];
		const outcome = buildAutonomyOutcome(f.step, null);
		expect(outcome.commit.experiences).toEqual([]);
		expect(outcome.commit.consumedInputIds).toEqual([]);
	} finally {
		f.close();
	}
});

test("feedback source must match its frozen original input before it can become experience", () => {
	const f = feedback();
	try {
		f.step.source.inputs[0] = {
			...f.input,
			source: { ...f.input.source, action: { kind: "reply", text: "forged" } },
		};
		expect(() => buildAutonomyOutcome(f.step, null)).toThrow(
			"Publication observation input mismatch",
		);
	} finally {
		f.close();
	}
});

test("an admitted maximum-length reply remains a valid experience without truncation", () => {
	const text = "x".repeat(32_768);
	const f = feedback({ kind: "reply", text });
	try {
		expect(buildAutonomyOutcome(f.step, null).commit.claims[0]?.text).toBe(
			text,
		);
	} finally {
		f.close();
	}
});
