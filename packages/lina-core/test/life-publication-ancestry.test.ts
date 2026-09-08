import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import {
	derivePublicationAncestry,
	PUBLICATION_ANCESTRY_SCHEMA,
	PublicationAncestry,
} from "../src/world/publication-ancestry.ts";
import { publicationObservationId } from "../src/world/publication-input.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function step() {
	const f = autonomyStoreFixture();
	try {
		const first = f.store.prepareLifeStep(f.request, () => 1);
		f.store.finishLifeStep(first.lease, first.id, f.clock());
		f.store.acceptLifeStep(
			first.lease,
			first.id,
			{ identity: f.request.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		const prepared = f.store.prepareLifeStep(
				{ ...f.request, idempotencyKey: "next" },
				() => 1,
			),
			saved = f.store.finishLifeStep(prepared.lease, prepared.id, f.clock());
		if (!saved.outcome) throw Error("Missing outcome");
		const id = publicationObservationId(saved.worldId, "reply", "lina"),
			source = {
				kind: "publication_interaction",
				observationId: id,
				interactionId: "reply",
				postId: "post",
				postRevision: 1,
				principal: { kind: "viewer", grantId: "reader" },
				recipientAgentId: "lina",
				action: { kind: "reply", text: "hello" },
				roots: [
					{ rootId: "root-a", depth: 2 },
					{ rootId: "root-b", depth: 1 },
				],
			};
		const input = parseLifeInput({
			version: 3,
			worldId: saved.worldId,
			id,
			sourceRevision: 1,
			source,
			payloadDigest: lifeDigest(source),
			consumedLifeRevision: null,
		});
		if (input.version !== 3) throw Error("Missing v3input");
		return {
			...saved,
			version: 3 as const,
			source: {
				...saved.source,
				inputs: [input],
				publication: {
					version: 1 as const,
					worldId: saved.worldId,
					revision: 1,
					permissionDigest: lifeDigest({ allowed: true }),
					authority: { settingsRevision: 0, posts: [], grants: [] },
					records: [{ inputId: id, source: input.source }],
				},
				publicationAncestry: [],
			},
			outcome: {
				...saved.outcome,
				commit: { ...saved.outcome.commit, consumedInputIds: [id] },
			},
		};
	} finally {
		f.close();
	}
}

test("a new event with no scheduled parent still inherits every consumed interaction root", () => {
	const value = step();
	expect(value.decision.parent).toBeNull();
	const rows = derivePublicationAncestry(value),
		event = rows.find((r) => r.kind === "event");
	expect(event?.roots).toEqual([
		{ rootId: "root-a", depth: 3 },
		{ rootId: "root-b", depth: 2 },
	]);
	expect(rows.find((r) => r.kind === "step")?.roots).toEqual(event?.roots);
	value.outcome.commit.consumedInputIds = [];
	expect(
		derivePublicationAncestry(value).every((r) => r.roots.length === 0),
	).toBe(true);
});

test("scheduled descendants merge root sets at maximum depth and cannot lose their saved parent", () => {
	const value = step(),
		parent = {
			id: "pending",
			familyId: "meet",
			actorIds: ["lina"],
			summary: "followup",
			parentStepId: "old-step",
			rootStepId: "old-step",
			depth: 1,
			status: "pending" as const,
		};
	const inherited = {
		...value,
		decision: { ...value.decision, parent },
		source: {
			...value.source,
			publicationAncestry: [
				{
					kind: "causal_event" as const,
					id: parent.id,
					lifeRevision: 1,
					roots: [
						{ rootId: "root-b", depth: 4 },
						{ rootId: "root-c", depth: 1 },
					],
				},
			],
		},
	};
	inherited.outcome.nextState.pendingEvents.push({
		...parent,
		id: "next",
		parentStepId: value.id,
	});
	const rows = derivePublicationAncestry(inherited);
	expect(rows.find((r) => r.kind === "event")?.roots).toEqual([
		{ rootId: "root-a", depth: 3 },
		{ rootId: "root-b", depth: 5 },
		{ rootId: "root-c", depth: 2 },
	]);
	expect(
		rows.find((r) => r.kind === "causal_event" && r.id === "next")?.roots,
	).toEqual([
		{ rootId: "root-a", depth: 4 },
		{ rootId: "root-b", depth: 6 },
		{ rootId: "root-c", depth: 3 },
	]);
	expect(() =>
		derivePublicationAncestry({
			...inherited,
			source: { ...inherited.source, publicationAncestry: [] },
		}),
	).toThrow();
});

test("ancestry rows restore exactly and reject altered roots, unsafe revisions and conflicting replay", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-ancestry-")),
		path = join(root, "world.sqlite");
	let db = new DatabaseSync(path);
	try {
		db.exec(
			"CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT;INSERT INTO worlds VALUES('test-world')",
		);
		db.exec(PUBLICATION_ANCESTRY_SCHEMA);
		const value = step(),
			rows = derivePublicationAncestry(value),
			store = new PublicationAncestry(db);
		store.record(value.worldId, rows);
		store.record(value.worldId, rows);
		db.close();
		db = new DatabaseSync(path);
		const reopened = new PublicationAncestry(db);
		reopened.validate();
		expect(reopened.list(value.worldId)).toEqual(
			[...rows].sort((a, b) =>
				`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
			),
		);
		expect(() =>
			reopened.record(
				value.worldId,
				rows.map((row) => ({ ...row, roots: [] })),
			),
		).toThrow();
		db.exec(
			"UPDATE life_publication_ancestry SET life_revision=9007199254740992",
		);
		expect(() => reopened.validate()).toThrow();
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
