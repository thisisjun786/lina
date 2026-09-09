import { expect, test } from "bun:test";
import { parseWorldDraftPreview } from "../src/world/authoring-receipt.ts";
import { lifeDigest } from "../src/world/life-json.ts";

function preview(version: 1 | 2) {
	const legacy = {
		version: 1,
		draftId: "draft",
		draftRevision: 1,
		worldId: "world",
		packDigest: null,
		options: {
			expectedWorldRevision: null,
			simulationTime: 0,
			agentId: "lina",
			targetAgentId: null,
			seed: "synthetic",
			limits: {
				maxChars: 1000,
				maxRecords: 20,
				maxDepth: 4,
				maxOperations: 1000,
			},
			relocations: [],
		},
		unresolved: [
			{
				id: "missing",
				question: "An authored detail is missing",
				blocking: true,
			},
		],
		changes: {
			addedAgents: [],
			retiredAgents: [],
			removedScenes: [],
			changedPlaces: [],
			changedRuleIds: [],
		},
		evaluation: null,
		canActivate: false,
	};
	const body =
		version === 2 ? { ...legacy, version: 2, socialMigration: null } : legacy;
	return { ...body, digest: lifeDigest(body) };
}

test("v2 previews bind an explicit migration slot and keep v1 bytes readable", () => {
	for (const version of [1, 2] as const) {
		const receipt = preview(version);
		expect(JSON.stringify(parseWorldDraftPreview(receipt))).toBe(
			JSON.stringify(receipt),
		);
	}
});

test("a recomputed outer checksum does not authorize malformed migration metadata", () => {
	const source = preview(2);
	const body = {
		...source,
		socialMigration: {
			version: 1,
			algorithm: "ensemble-migration-v1",
			fromPackVersion: 1,
			toPackVersion: 2,
			fromPackDigest: lifeDigest("old"),
			toPackDigest: lifeDigest("new"),
			previousCheckpointDigest: lifeDigest("before"),
			nextCheckpointDigest: lifeDigest("after"),
			worldRevision: 1,
			lifeRevision: 1,
			simulationTime: 1,
			operations: [{ kind: "variable_added", id: "weather" }],
		},
	};
	const { digest: _old, ...unsigned } = body;
	const migration = {
		...body.socialMigration,
		digest: lifeDigest(body.socialMigration),
	};
	const complete = {
		...unsigned,
		packDigest: migration.toPackDigest,
		options: {
			...unsigned.options,
			expectedWorldRevision: 0,
			simulationTime: 1,
		},
		socialMigration: migration,
	};
	expect(
		parseWorldDraftPreview({ ...complete, digest: lifeDigest(complete) })
			.version,
	).toBe(2);
	const corrupt = {
		...complete,
		socialMigration: { ...migration, unknown: true },
	};
	expect(() =>
		parseWorldDraftPreview({ ...corrupt, digest: lifeDigest(corrupt) }),
	).toThrow();
});
