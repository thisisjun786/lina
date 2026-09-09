import { expect, test } from "bun:test";
import { buildAutonomyOutcome } from "../src/world/autonomy-transition.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import {
	applyPublicationBudget,
	freezePublicationBudget,
	parsePublicationBudget,
} from "../src/world/publication-budget.ts";
import type { PublicationChainSnapshot } from "../src/world/publication-chains.ts";
import { publicationExperiences } from "../src/world/publication-experience.ts";
import { publicationObservationId } from "../src/world/publication-input.ts";
import type { PublicationSettings } from "../src/world/publication-types.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function fixture() {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 1);
		const id = publicationObservationId(step.worldId, "reply", "lina");
		const source = {
			kind: "publication_interaction",
			observationId: id,
			interactionId: "reply",
			postId: "post",
			postRevision: 1,
			principal: { kind: "viewer", grantId: "reader" },
			recipientAgentId: "lina",
			action: { kind: "reply", text: "Reader feedback" },
			roots: [
				{ rootId: "root-a", depth: 1 },
				{ rootId: "root-b", depth: 1 },
			],
		};
		const input = parseLifeInput({
			version: 3,
			worldId: step.worldId,
			id,
			sourceRevision: 1,
			source,
			payloadDigest: lifeDigest(source),
			consumedLifeRevision: null,
		});
		if (input.version !== 3) throw Error("Expected publication input");
		step.source.inputs = [input];
		step.source.publication = {
			version: 1,
			worldId: step.worldId,
			revision: 1,
			permissionDigest: lifeDigest("synthetic-permission"),
			authority: { settingsRevision: 1, posts: [], grants: [] },
			records: [{ inputId: id, source: input.source }],
		};
		const settings: PublicationSettings = {
			version: 1,
			worldId: step.worldId,
			revision: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 8,
			maxActionsPerChain: 4,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		};
		const chain: PublicationChainSnapshot = {
			version: 1,
			worldId: step.worldId,
			revision: 2,
			digest: lifeDigest("chain"),
			roots: [
				{ rootId: "root-a", actions: 2 },
				{ rootId: "root-b", actions: 2 },
			],
		};
		return { step, input, settings, chain };
	} finally {
		f.close();
	}
}

test("an exhausted member holds the entire mixed-root feedback group without consuming it", () => {
	const f = fixture();
	f.chain.roots[1] = { rootId: "root-b", actions: 4 };
	f.chain.revision = 4;
	f.step.source.publicationBudget = freezePublicationBudget(
		f.step.source,
		f.chain,
		f.settings,
	);
	expect(f.step.source.publicationBudget.blockedInputIds).toEqual([f.input.id]);
	expect(publicationExperiences(f.step)).toEqual([]);
	const outcome = buildAutonomyOutcome(f.step, null);
	expect(outcome.commit.consumedInputIds).toEqual([]);
	expect(outcome.commit.experiences).toEqual([]);
	expect(outcome.kind).toBe("quiet");
});

test("depth is checked for the next step, while absent settings never invent allowance", () => {
	const f = fixture();
	f.settings.maxChainDepth = 1;
	expect(
		freezePublicationBudget(f.step.source, f.chain, f.settings).blockedInputIds,
	).toEqual([f.input.id]);
	if (!f.step.source.publication) throw Error("Missing publication");
	f.step.source.publication.authority.settingsRevision = 0;
	expect(
		freezePublicationBudget(f.step.source, f.chain, null).blockedInputIds,
	).toEqual([f.input.id]);
});

test("one accepted step and each admitted causal child spend all inherited roots in deterministic order", () => {
	const f = fixture();
	f.step.source.publicationBudget = freezePublicationBudget(
		f.step.source,
		f.chain,
		f.settings,
	);
	const state = structuredClone(f.step.source.autonomy);
	for (const id of ["child-b", "child-a"])
		state.pendingEvents.push({
			id,
			familyId: "meet",
			actorIds: ["lina"],
			summary: "Follow up",
			parentStepId: f.step.id,
			rootStepId: f.step.id,
			depth: 1,
			status: "pending",
		});
	const before = structuredClone(f.step.source.publicationBudget);
	const actions = applyPublicationBudget(f.step, state);
	expect(actions.map((action) => action.id)).toEqual([f.step.id, "child-a"]);
	expect(actions[0]?.roots).toEqual([
		{ rootId: "root-a", depth: 2 },
		{ rootId: "root-b", depth: 2 },
	]);
	expect(actions[1]?.roots).toEqual([
		{ rootId: "root-a", depth: 3 },
		{ rootId: "root-b", depth: 3 },
	]);
	expect(
		state.pendingEvents.find((event) => event.id === "child-b")?.status,
	).toBe("stopped");
	expect(
		state.pendingEvents.find((event) => event.id === "child-a")?.status,
	).toBe("pending");
	expect(f.step.source.publicationBudget).toEqual(before);
});

test("exhausted scheduled ancestry is stopped without blocking an independent quiet tick", () => {
	const f = fixture();
	f.step.source.inputs = [];
	if (!f.step.source.publication) throw Error("Missing publication");
	f.step.source.publication.records = [];
	f.chain.roots[0] = { rootId: "root-a", actions: 4 };
	f.chain.revision = 4;
	f.step.source.autonomy.pendingEvents.push({
		id: "pending",
		familyId: "meet",
		actorIds: ["lina"],
		summary: "Follow up",
		parentStepId: "old-step",
		rootStepId: "old-step",
		depth: 1,
		status: "pending",
	});
	f.step.source.publicationAncestry = [
		{
			kind: "causal_event",
			id: "pending",
			lifeRevision: 1,
			roots: [{ rootId: "root-a", depth: 2 }],
		},
	];
	f.step.source.life.revision = 1;
	f.step.source.publicationBudget = freezePublicationBudget(
		f.step.source,
		f.chain,
		f.settings,
	);
	expect(f.step.source.publicationBudget.blockedCausalEventIds).toEqual([
		"pending",
	]);
	const state = structuredClone(f.step.source.autonomy);
	expect(applyPublicationBudget(f.step, state)).toEqual([]);
	expect(state.pendingEvents[0]?.status).toBe("stopped");
});

test("budget parsing rejects fabricated limits and mismatched world or duplicate exclusions", () => {
	const f = fixture();
	const budget = freezePublicationBudget(f.step.source, f.chain, f.settings);
	expect(parsePublicationBudget(budget)).toEqual(budget);
	expect(() =>
		parsePublicationBudget({
			...budget,
			limits: { ...budget.limits, maxChainDepth: -1 },
		}),
	).toThrow();
	expect(() =>
		parsePublicationBudget({
			...budget,
			blockedInputIds: [f.input.id, f.input.id],
		}),
	).toThrow();
	expect(() =>
		freezePublicationBudget(
			f.step.source,
			{ ...f.chain, worldId: "other" },
			f.settings,
		),
	).toThrow();
	expect(() =>
		freezePublicationBudget(f.step.source, f.chain, {
			...f.settings,
			revision: 2,
		}),
	).toThrow();
});
