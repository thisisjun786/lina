import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
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
const rules = {
	...legacy,
	version: 2 as const,
	worldVersion: 1,
	eventRules: [
		{
			familyId: "meet",
			authorAgentIds: ["lina"],
			recipientIds: ["friends"],
			summary: "Residents met.",
		},
	],
};

test("v1 settings bytes survive explicit v2 policy and full reopen; stale authored version is refused", () => {
	const f = autonomyStoreFixture();
	let reopened: WorldStore | undefined;
	try {
		f.store.setPublicationSettings("test-world", 0, legacy);
		const db = new DatabaseSync(f.path);
		const row = () =>
			db
				.prepare(
					"SELECT settings_json,digest FROM life_publication_settings_history WHERE world_id=? AND revision=1",
				)
				.get("test-world");
		const original = row();
		try {
			expect(() =>
				f.store.setPublicationSettings("test-world", 1, {
					...rules,
					worldVersion: 2,
				}),
			).toThrow();
			expect(f.store.publicationSettings("test-world")?.revision).toBe(1);
			const saved = f.store.setPublicationSettings("test-world", 1, rules);
			expect(saved).toMatchObject({ version: 2, worldVersion: 1, revision: 2 });
			expect(row()).toEqual(original);
			f.store.close();
			reopened = new WorldStore(f.path, f.clock);
			expect(reopened.publicationSettings("test-world")).toEqual(saved);
			expect(row()).toEqual(original);
		} finally {
			db.close();
		}
	} finally {
		reopened?.close();
		f.close();
	}
});

test.each(["family", "actor", "version"] as const)(
	"startup rejects rehashed v2 %s references to nonexistent authored source without repairing them",
	(kind) => {
		const f = autonomyStoreFixture();
		try {
			f.store.setPublicationSettings("test-world", 0, rules);
			f.store.close();
			const changed = structuredClone(rules);
			const rule = changed.eventRules[0];
			if (!rule) throw Error("Missing rule");
			if (kind === "family") rule.familyId = "invented";
			if (kind === "actor") rule.authorAgentIds = ["invented"];
			if (kind === "version") changed.worldVersion = 999;
			const json = canonicalLifeJson(changed),
				digest = lifeDigest(changed);
			const db = new DatabaseSync(f.path);
			try {
				for (const table of [
					"life_publication_settings",
					"life_publication_settings_history",
				])
					db.prepare(
						`UPDATE ${table} SET settings_json=?,digest=? WHERE world_id=?`,
					).run(json, digest, "test-world");
				expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
				expect(
					db
						.prepare(
							"SELECT settings_json FROM life_publication_settings WHERE world_id=?",
						)
						.get("test-world")?.["settings_json"],
				).toBe(json);
			} finally {
				db.close();
			}
		} finally {
			f.close();
		}
	},
);

test("legacy nonautonomous LIFE keeps v1 publication but cannot claim an authored future-event rule", () => {
	const store = publicationStoreFixture();
	try {
		expect(() =>
			store.setPublicationSettings("test-world", 1, rules),
		).toThrow();
		expect(store.publicationSettings("test-world")?.version).toBe(1);
	} finally {
		store.close();
	}
});
