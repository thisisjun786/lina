import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifeDigest } from "../src/world/life-json.ts";
import { publicationNarrationMaterial } from "../src/world/publication-material.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	identityPolicy,
	lifeCommit,
	lifeDefinition,
	socialCommit,
} from "./life-fixture.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

const limits = { maxChars: 20000, maxRecords: 100 };
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-selection-"));
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path);
	store.create(worldDefinition());
	const definition = lifeDefinition();
	for (const [kind, id, recipients] of [
		["world_event", "test-world:1", ["friends", "public"]],
		["world_scene", "meeting", ["friends"]],
		["world_fact", "bell", ["friends", "public"]],
		["life_claim", "false-claim", ["friends"]],
	] as const)
		definition.projection.disclosures.push({
			subject: { kind, id },
			policy: {
				knowers: ["lina"],
				publication: [...recipients],
				disclosures: recipients.map((recipientId) => ({
					agentId: "lina",
					recipientId,
				})),
			},
		});
	store.prepareLife(definition);
	const payload = {
		kind: "publication_candidate" as const,
		eventId: "test-world:1",
	};
	store.acceptLife(
		{
			...socialCommit(),
			effects: [
				{
					version: 1,
					worldId: "test-world",
					id: "publish-1",
					lifeRevision: 1,
					payload,
					payloadDigest: lifeDigest(payload),
				},
			],
		},
		identityPolicy(),
	);
	const {
		worldId: _w,
		revision: _r,
		...config
	} = store.lifeConfig("test-world");
	store.setLifeConfig("test-world", 0, {
		...config,
		publication: { mode: "manual", recipientIds: ["friends", "public"] },
	});
	store.setPublicationSettings("test-world", 0, {
		version: 1,
		agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
		reactionIds: [],
		maxChainDepth: 3,
		maxActionsPerChain: 10,
		perAuthorCooldownSteps: 0,
		maxJobsPerRun: 1,
	});
	return {
		store,
		path,
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("material selects exact disclosed statements for each recipient and never exposes private narration inputs", () => {
	const f = fixture();
	try {
		const friends = f.store.publicationMaterial(
			"test-world",
			"publish-1",
			"lina",
			["friends"],
			limits,
		);
		const publicView = f.store.publicationMaterial(
			"test-world",
			"publish-1",
			"lina",
			["public"],
			limits,
		);
		const shared = f.store.publicationMaterial(
			"test-world",
			"publish-1",
			"lina",
			["public", "friends"],
			limits,
		);
		expect(friends?.allowedClaims.map((x) => x.text)).toContain(
			"The key is red",
		);
		expect(publicView?.allowedClaims.map((x) => x.text)).not.toContain(
			"The key is red",
		);
		expect(friends?.permittedScene?.place.name).toBe("Test garden");
		expect(publicView?.permittedScene).toBeNull();
		expect(shared?.allowedClaims).toEqual(publicView?.allowedClaims);
		if (!friends) throw Error("Missing permitted fixture");
		const prompt = JSON.stringify(publicationNarrationMaterial(friends));
		for (const secret of [
			"The hidden key is blue",
			"Mira whispered",
			"truth",
			"sourceEventId",
			"knowers",
			"told",
			"sourceId",
			"workEvidenceDigest",
			"recipientId",
			"test-world:1",
		])
			expect(prompt).not.toContain(secret);
		expect(
			f.store.publicationMaterial(
				"test-world",
				"publish-1",
				"sol",
				["friends"],
				limits,
			),
		).toBeNull();
		expect(
			f.store.publicationMaterial(
				"test-world",
				"publish-1",
				"lina",
				["unknown"],
				limits,
			),
		).toBeNull();
		expect(() =>
			f.store.publicationMaterial(
				"test-world",
				"publish-1",
				"lina",
				[],
				limits,
			),
		).toThrow();
	} finally {
		f.close();
	}
});

test("later movement and actual reopen preserve event-time material while current audience revocation withholds it", () => {
	const f = fixture();
	try {
		const before = f.store.publicationMaterial(
			"test-world",
			"publish-1",
			"lina",
			["friends"],
			limits,
		);
		f.store.acceptLife(
			lifeCommit({
				expectedLifeRevision: 1,
				world: worldActivity({
					idempotencyKey: "move",
					expectedRevision: 1,
					simulationTime: 2,
					facts: [],
					moves: [{ agentId: "lina", sceneId: "reading" }],
				}),
			}),
			identityPolicy(),
		);
		expect(
			f.store.publicationMaterial(
				"test-world",
				"publish-1",
				"lina",
				["friends"],
				limits,
			),
		).toEqual(before);
		f.store.close();
		const reopened = new WorldStore(f.path);
		try {
			expect(
				reopened.publicationMaterial(
					"test-world",
					"publish-1",
					"lina",
					["friends"],
					limits,
				),
			).toEqual(before);
			const {
				worldId: _w,
				revision,
				...config
			} = reopened.lifeConfig("test-world");
			reopened.setLifeConfig("test-world", revision, {
				...config,
				publication: { mode: "manual", recipientIds: ["public"] },
			});
			expect(
				reopened.publicationMaterial(
					"test-world",
					"publish-1",
					"lina",
					["friends"],
					limits,
				),
			).toBeNull();
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});
