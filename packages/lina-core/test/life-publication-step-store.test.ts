import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

test.each(["missing", "future", "exclusion"] as const)(
	"actual reopen rejects %s publication budget evidence even after rehashing the step",
	(kind) => {
		const f = autonomyStoreFixture();
		try {
			const step = f.store.prepareLifeStep(f.request, () => 1);
			if (!step.source.publicationBudget)
				throw Error("Missing prepared budget");
			if (kind === "missing") delete step.source.publicationBudget;
			else if (kind === "future") {
				step.source.publicationBudget.chain.revision = 1;
				step.source.publicationBudget.chain.digest = lifeDigest("fabricated");
			} else step.source.publicationBudget.blockedInputIds = ["invented-input"];
			f.store.close();
			const db = new DatabaseSync(f.path);
			try {
				db.prepare(
					"UPDATE life_steps SET step_json=?,digest=? WHERE step_id=?",
				).run(canonicalLifeJson(step), lifeDigest(step), step.id);
			} finally {
				db.close();
			}
			expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
		} finally {
			f.close();
		}
	},
);

test("publication authority changes release a pending step for fresh work instead of stranding its stale guard", () => {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 1);
		expect(() =>
			f.store.assertPublicationEvidenceCurrent(f.request.worldId, step.id),
		).not.toThrow();
		f.store.setPublicationSettings(f.request.worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 3,
			maxActionsPerChain: 10,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		});
		expect(f.store.lifeStep(f.request.worldId, step.id).status).toBe("stale");
		expect(() =>
			f.store.assertPublicationEvidenceCurrent(f.request.worldId, step.id),
		).toThrow("Stale publication evidence");
		const next = f.store.prepareLifeStep(
			{ ...f.request, idempotencyKey: "fresh" },
			() => {
				throw Error("No new seed");
			},
		);
		expect(next.source.publication?.authority.settingsRevision).toBe(1);
		expect(next.lease.generation).toBeGreaterThan(step.lease.generation);
		expect(() =>
			f.store.finishLifeStep(step.lease, step.id, f.clock()),
		).toThrow();
	} finally {
		f.close();
	}
});

test("new steps freeze explicit publication authority with work evidence and execute as v3 across actual WorldStore reopen", () => {
	const f = autonomyStoreFixture();
	let reopened: WorldStore | undefined;
	try {
		const step = f.store.prepareLifeStep(f.request, () => 1);
		expect(step.version).toBe(3);
		expect(step.source.work).toBeDefined();
		expect(step.source.workAncestry).toEqual([]);
		expect(step.source.publication).toMatchObject({
			version: 1,
			worldId: f.request.worldId,
			revision: 0,
			authority: { settingsRevision: 0, posts: [], grants: [] },
			records: [],
		});
		expect(step.source.publicationAncestry).toEqual([]);
		f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.request.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		const accepted = f.store.lifeStep(f.request.worldId, step.id);
		f.store.close();
		reopened = new WorldStore(f.path, f.clock);
		expect(reopened.lifeStep(f.request.worldId, step.id)).toEqual(accepted);
		expect(
			reopened.prepareLifeStep({ ...f.request, idempotencyKey: "next" }, () => {
				throw Error("Do not reroll seed");
			}).version,
		).toBe(3);
	} finally {
		reopened?.close();
		f.close();
	}
});
