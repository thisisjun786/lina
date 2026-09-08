import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { LifeModelReceipts } from "../src/world/autonomy-model-receipts.ts";
import { LifeStepRecords } from "../src/world/autonomy-step-records.ts";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { publicationObservationId } from "../src/world/publication-input.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

// Codec-only fixture: this deliberately changes an envelope to test decoding.
// It does not claim a v3 step was prepared or executed through WorldStore.
function codecFixture() {
	const f = autonomyStoreFixture();
	const saved = structuredClone(f.store.prepareLifeStep(f.request, () => 1));
	const budget = saved.source.publicationBudget;
	if (!budget) throw Error("Missing prepared publication budget");
	saved.version = 2;
	delete saved.source.publication;
	delete saved.source.publicationAncestry;
	delete saved.source.publicationBudget;
	const step: LifeStep = {
		...saved,
		version: 3,
		source: {
			...saved.source,
			publication: {
				version: 1,
				worldId: saved.worldId,
				revision: 0,
				permissionDigest: lifeDigest({ none: true }),
				authority: { settingsRevision: 0, posts: [], grants: [] },
				records: [],
			},
			publicationAncestry: [],
			publicationBudget: budget,
		},
	};
	return { ...f, saved, step };
}
function decode(f: ReturnType<typeof codecFixture>, value: unknown) {
	let db = new DatabaseSync(f.path);
	try {
		db.prepare(
			"UPDATE life_steps SET step_json=?,digest=? WHERE world_id=? AND step_id=?",
		).run(
			canonicalLifeJson(value),
			lifeDigest(value),
			f.saved.worldId,
			f.saved.id,
		);
		db.close();
		db = new DatabaseSync(f.path);
		return new LifeStepRecords(db, new LifeModelReceipts(db, f.clock)).get(
			f.saved.worldId,
			f.saved.id,
		);
	} finally {
		db.close();
	}
}

test("step v3 codec preserves all work fields and publication authority while old step bytes remain readable", () => {
	const f = codecFixture();
	try {
		expect(decode(f, f.step)).toEqual(f.step);
		expect(decode(f, f.saved)).toEqual(f.saved);
		const legacy = structuredClone(f.saved);
		legacy.version = 1;
		delete legacy.source.work;
		delete legacy.source.workAncestry;
		delete legacy.source.publication;
		delete legacy.source.publicationAncestry;
		expect(decode(f, legacy)).toEqual(legacy);
	} finally {
		f.close();
	}
});

test.each([
	"work",
	"workAncestry",
	"publication",
	"publicationAncestry",
	"publicationBudget",
] as const)("v3 codec cannot infer a missing %s snapshot", (key) => {
	const f = codecFixture();
	try {
		delete f.step.source[key];
		expect(() => decode(f, f.step)).toThrow();
	} finally {
		f.close();
	}
});

test("v3 codec rejects unknown and foreign-world publication authority even with an updated row digest", () => {
	const f = codecFixture();
	try {
		if (!f.step.source.publication) throw Error("fixture source missing");
		f.step.source.publication.worldId = "foreign";
		expect(() => decode(f, f.step)).toThrow();
		f.step.source.publication.worldId = f.step.worldId;
		expect(() =>
			decode(f, {
				...f.step,
				source: { ...f.step.source, rawTask: "forbidden" },
			}),
		).toThrow();
	} finally {
		f.close();
	}
});

test.each([1, 2] as const)(
	"legacy step v%s cannot smuggle a trusted publication input without its authority snapshot",
	(version) => {
		const f = codecFixture();
		try {
			const step = structuredClone(f.saved);
			step.version = version;
			delete step.source.publication;
			delete step.source.publicationAncestry;
			if (version === 1) {
				delete step.source.work;
				delete step.source.workAncestry;
			}
			const id = publicationObservationId(step.worldId, "interaction", "lina");
			const source = {
				kind: "publication_interaction" as const,
				observationId: id,
				interactionId: "interaction",
				postId: "post",
				postRevision: 1,
				principal: { kind: "viewer" as const, grantId: "viewer" },
				recipientAgentId: "lina",
				action: { kind: "reshare" as const },
				roots: [{ rootId: "root", depth: 1 }],
			};
			step.source.inputs = [
				{
					version: 3,
					worldId: step.worldId,
					id,
					sourceRevision: 1,
					payloadDigest: lifeDigest(source),
					source,
					consumedLifeRevision: null,
				},
			];
			expect(() => decode(f, step)).toThrow(
				"Legacy step cannot carry publication input",
			);
		} finally {
			f.close();
		}
	},
);
