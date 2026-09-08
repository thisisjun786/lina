import { expect, test } from "bun:test";
import { buildAutonomyOutcome } from "../src/world/autonomy-transition.ts";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import type { LifeInputV3 } from "../src/world/life-types.ts";
import { freezePublicationBudget } from "../src/world/publication-budget.ts";
import { publicationObservationId } from "../src/world/publication-input.ts";
import type { PublicationRenderedSegment } from "../src/world/publication-types.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

const segments: PublicationRenderedSegment[] = [
	{ kind: "claim", claimKind: "world_event", text: "A bell rang." },
	{ kind: "claim", claimKind: "world_fact", text: "The door is blue." },
	{
		kind: "claim",
		claimKind: "life_claim",
		text: "Someone reported a visitor.",
	},
	{ kind: "imaginative", text: "Perhaps the moon answered." },
];
function feedback(rendered = segments) {
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
	const id = publicationObservationId(
		prior.worldId,
		"generated-interaction",
		"lina",
	);
	const source: LifeInputV3["source"] = {
		kind: "publication_interaction",
		observationId: id,
		interactionId: "generated-interaction",
		postId: "private-generated-child",
		postRevision: 1,
		principal: { kind: "agent", agentId: "mira" },
		recipientAgentId: "lina",
		action: { kind: "generated_reply", segments: rendered },
		roots: [{ rootId: "private-root", depth: 2 }],
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
				permissionDigest: lifeDigest({ permitted: true }),
				authority: {
					settingsRevision: 1,
					posts: [{ id: source.postId, kind: "post", revision: 1 }],
					grants: [],
				},
				records: [{ inputId: id, source }],
			},
		},
	};
	if (!prior.source.publicationBudget) throw Error("Missing fixture budget");
	step.source.publicationBudget = freezePublicationBudget(
		step.source,
		prior.source.publicationBudget.chain,
		settings,
	);
	return { step, input, close: f.close };
}

test("generated actor projection retains typed segments and attribution only for the recipient", () => {
	const f = feedback();
	try {
		f.step.decision = { ...f.step.decision, agentId: "lina" };
		const own = buildLifeModelInput(f.step, "director", "lina");
		expect(JSON.parse(own.input).publicationFeedback).toEqual([
			{
				from: { kind: "agent", agentId: "mira" },
				action: { kind: "generated_reply", segments },
			},
		]);
		for (const secret of [
			"private-generated-child",
			"private-root",
			"generated-interaction",
		])
			expect(own.input).not.toContain(secret);
		f.step.reflectionAgentIds = ["mira"];
		expect(
			buildLifeModelInput(f.step, "reflection", "mira").input,
		).not.toContain("Perhaps the moon answered.");
	} finally {
		f.close();
	}
});

test("generated claims and imaginative prose become one private told unknown claim without truth or persona upgrades", () => {
	const f = feedback();
	try {
		const before = structuredClone(f.step);
		const { commit } = buildAutonomyOutcome(f.step, null);
		expect(commit.claims).toHaveLength(1);
		expect(commit.claims[0]).toMatchObject({
			text: "[claim:world_event] A bell rang.\n[claim:world_fact] The door is blue.\n[claim:life_claim] Someone reported a visitor.\n[imaginative] Perhaps the moon answered.",
			truth: "unknown",
			disclosure: { knowers: ["lina"], disclosures: [], publication: [] },
		});
		expect(commit.experiences).toHaveLength(1);
		expect(commit.experiences[0]).toMatchObject({
			agentId: "lina",
			channel: "told",
		});
		expect(commit.consumedInputIds).toEqual([f.input.id]);
		expect(commit.growth).toEqual([]);
		expect(commit.effects).toEqual([]);
		expect(f.step).toEqual(before);
	} finally {
		f.close();
	}
});

test("maximum generated experience includes provenance labels without truncation", () => {
	const prose = "x".repeat(32_768 - "[imaginative] ".length);
	const f = feedback([{ kind: "imaginative", text: prose }]);
	try {
		expect(buildAutonomyOutcome(f.step, null).commit.claims[0]?.text).toBe(
			`[imaginative] ${prose}`,
		);
	} finally {
		f.close();
	}
});

test("excluded generated evidence and consumed input produce no new experience", () => {
	const f = feedback();
	try {
		f.input.consumedLifeRevision = 1;
		expect(buildAutonomyOutcome(f.step, null).commit.experiences).toEqual([]);
		f.input.consumedLifeRevision = null;
		if (!f.step.source.publication) throw Error("Missing evidence");
		f.step.source.publication.records = [];
		const { commit } = buildAutonomyOutcome(f.step, null);
		expect(commit.experiences).toEqual([]);
		expect(commit.consumedInputIds).toEqual([]);
	} finally {
		f.close();
	}
});
