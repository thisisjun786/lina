import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { autonomySource } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "../../lina-core/test/life-publication-store-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import {
	RuntimeClock,
	RuntimeForeground,
	RuntimeModel,
} from "./life-runtime-fixture.ts";

test.each(["depth", "actions", "cooldown"] as const)(
	"two real agents stop generated replies at the configured %s limit before another model call",
	async (limit) => {
		const root = mkdtempSync(join(tmpdir(), "lina-publication-loop-")),
			path = join(root, "world.sqlite"),
			worldId = "test-world";
		const store = publicationStoreFixture(path),
			clock = new RuntimeClock(),
			model = new RuntimeModel();
		clock.time = 1000;
		const source = autonomySource();
		const saved = store.publicationSettings(worldId);
		if (!saved) throw Error("Missing settings");
		const { worldId: _world, revision, ...settings } = saved;
		store.setPublicationSettings(worldId, revision, {
			...settings,
			agentRecipients: [
				{ agentId: "lina", recipientId: "friends" },
				{ agentId: "mira", recipientId: "friends" },
			],
			maxChainDepth: limit === "depth" ? 2 : 20,
			maxActionsPerChain: limit === "actions" ? 3 : 20,
			perAuthorCooldownSteps: limit === "cooldown" ? 1 : 0,
		});
		model.text = () =>
			JSON.stringify({
				kind: "post",
				segments: [
					{ kind: "imaginative", text: "I wonder what tomorrow will bring." },
				],
			});
		const runner = createLifeRunner({
			store,
			clock,
			model,
			foreground: new RuntimeForeground(),
			engine: createEnsembleSocialEngine(),
			identity: () => ({
				identity: source.identity,
				profiles: source.profiles,
				modelSettingsRevision: 1,
			}),
			owner: "reply-loop",
			leaseMs: 300,
			publication: {
				store,
				author: (_world, agentId) => ({
					...publicationAuthor,
					agentId,
					name: agentId,
				}),
			},
		});
		let db: DatabaseSync | undefined;
		try {
			const runs = [];
			for (let i = 0; i < 5; i++) {
				const input = store.automaticPublicationInput(worldId);
				if (!input) break;
				runs.push(
					await runner.publish(worldId, input, new AbortController().signal),
				);
			}
			const authors =
				limit === "cooldown" ? ["lina", "mira"] : ["lina", "mira", "lina"];
			expect(runs.map((run) => run.outcomes)).toEqual([
				...authors.map(() => ["published" as const]),
				["withheld" as const],
			]);
			expect(model.requests.map((request) => request.agentId)).toEqual(authors);
			expect(model.prepared).toHaveLength(authors.length);
			expect(store.automaticPublicationInput(worldId)).toBeNull();
			const feed = store.publicationFeed(
				worldId,
				{ kind: "agent", agentId: "lina" },
				{ limit: 10, after: null },
			);
			expect(feed.items).toHaveLength(authors.length);
			expect(feed.items.filter((post) => post.kind === "reply")).toHaveLength(
				authors.length - 1,
			);
			db = new DatabaseSync(path);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM life_publication_chain_actions",
					)
					.get()?.["count"],
			).toBe(authors.length);
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM life_publication_observations",
					)
					.get()?.["count"],
			).toBe(authors.length - 1);
			const inputs = store
				.lifeInputs(worldId)
				.filter((input) => input.version === 3);
			expect(inputs).toHaveLength(authors.length - 1);
			for (const input of inputs) {
				if (input.version !== 3) throw Error("Trusted observation required");
				expect(input.source.action.kind).toBe("generated_reply");
				expect(
					feed.items.find((post) => post.id === input.source.postId)?.kind,
				).toBe("reply");
			}
			await runner.close();
			store.close();
			const reopened = new WorldStore(path, () => clock.now());
			try {
				expect(reopened.automaticPublicationInput(worldId)).toBeNull();
				expect(
					reopened.lifeInputs(worldId).filter((input) => input.version === 3),
				).toEqual(inputs);
				expect(
					reopened.publicationFeed(
						worldId,
						{ kind: "agent", agentId: "lina" },
						{ limit: 10, after: null },
					),
				).toEqual(feed);
			} finally {
				reopened.close();
			}
			if (limit === "cooldown") {
				// Remove the whole new observation graph, leaving valid post/job/charge
				// histories. Recovery must still notice the missing generated owner.
				for (const table of [
					"life_publication_observations",
					"life_publication_reaction_heads",
					"life_publication_interactions",
					"life_publication_interaction_receipts",
					"life_publication_interaction_state",
				])
					db.exec(`DELETE FROM ${table}`);
				db.exec(
					"DELETE FROM life_inputs WHERE json_extract(input_json,'$.version')=3",
				);
				expect(() => new WorldStore(path, () => clock.now()).close()).toThrow(
					"Missing generated publication observation graph",
				);
			}
		} finally {
			await runner.close();
			store.close();
			db?.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
