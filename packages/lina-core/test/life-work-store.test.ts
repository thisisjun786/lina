import { afterEach, expect, test } from "bun:test";
import { parseLifeConfigInput } from "../src/world/authoring-request-validation.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput as work } from "./life-work-fixture.ts";

const close: Array<() => void> = [];
afterEach(() => {
	for (const fn of close.splice(0).reverse()) fn();
});
function fixture() {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const { worldId, revision, ...config } = f.store.lifeConfig(
		f.request.worldId,
	);
	const familyId = f.source.pack.eventFamilies[0]?.id;
	if (!familyId) throw Error("Missing family");
	f.store.setLifeConfig(
		worldId,
		revision,
		parseLifeConfigInput({
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "work",
						familyId,
						categoryId: "research",
						outcomes: [],
						attribution: "participant",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		}),
	);
	return f;
}

test("trusted work admission is atomic, replayable and restores its current evidence", () => {
	const f = fixture(),
		worldId = f.request.worldId,
		input = work(worldId);
	const receipt = f.store.admitWorkInput(input);
	expect(receipt.replayed).toBe(false);
	const snapshot = f.store.workEvidence(worldId);
	expect(snapshot.records).toHaveLength(1);
	expect(snapshot.records[0]?.source).toEqual(input.source);
	expect(f.store.admitWorkInput(input).replayed).toBe(true);
	expect(f.store.workEvidence(worldId)).toEqual(snapshot);
	expect(() =>
		f.store.admitWorkInput({
			...input,
			source: { ...input.source, sourceDigest: "b".repeat(64) },
		}),
	).toThrow();
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.workEvidence(worldId)).toEqual(snapshot);
	expect(reopened.admitWorkInput(input).replayed).toBe(true);
});

test("restrictions remain admissible after destination work is disabled and cannot be undone by stale delivery", () => {
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(work(worldId));
	const before = f.store.workEvidence(worldId);
	const { worldId: _world, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(
		worldId,
		revision,
		parseLifeConfigInput({ ...config, version: 2, work: null }),
	);
	expect(f.store.workEvidence(worldId).permissionRevision).toBeGreaterThan(
		before.permissionRevision,
	);
	expect(f.store.admitWorkInput(work(worldId, 2, true)).replayed).toBe(false);
	const restricted = f.store.workEvidence(worldId);
	expect(restricted.records[0]?.source.operation).toBe("restrict");
	expect(f.store.admitWorkInput(work(worldId)).replayed).toBe(true);
	expect(f.store.workEvidence(worldId)).toEqual(restricted);
	expect(() => f.store.admitWorkInput(work(worldId, 3))).toThrow(
		/work|config/i,
	);
});

test("a corrected receipt invalidates permission proofs even when the sharing policy revision stays the same", () => {
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(work(worldId));
	const before = f.store.workEvidence(worldId);
	const next = work(worldId);
	next.id = "corrected-delivery";
	next.source.deliveryId = next.id;
	next.source.receipt = {
		...next.source.receipt,
		receiptRevision: 2,
		supersedesRevision: 1,
		correction: { kind: "amend", reason: "Correction" },
	};
	next.sourceRevision = 2;
	next.payloadDigest = lifeDigest(next.source);
	f.store.admitWorkInput(next);
	expect(f.store.workEvidence(worldId).permissionRevision).toBeGreaterThan(
		before.permissionRevision,
	);
});

test("first resource input atomically upgrades task history and reopens mixed evidence", () => {
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(work(worldId));
	const prior = f.store.workEvidence(worldId);
	const source = {
		kind: "resource_activity" as const,
		version: 1 as const,
		deliveryId: "resource-delivery",
		operation: "upsert" as const,
		sourceDigest: lifeDigest("actual source"),
		policyRevision: 1,
		receipt: {
			activityId: "activity",
			activityRevision: 1,
			supersedesRevision: null,
			resourceId: "resource",
			resourceRevision: 1,
			versionId: "version",
			memoryId: null,
			actorAgentId: "lina",
			participantAgentIds: ["lina"],
			activityKind: "search" as const,
			outcome: "recorded" as const,
			evidenceDigest: lifeDigest([]),
			grantId: "grant",
			grantRevision: 1,
			correction: null,
		},
		fields: {
			categoryId: "research",
			outcome: "recorded" as const,
			participantAgentIds: ["lina"],
			summary: "Searched reference",
		},
	};
	const input = {
		version: 4 as const,
		worldId,
		id: source.deliveryId,
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
	expect(f.store.admitWorkInput(input).replayed).toBe(false);
	const next = f.store.workEvidence(worldId);
	expect(next.version).toBe(2);
	expect(next.revision).toBe(prior.revision + 2);
	expect(next.records).toHaveLength(2);
	expect(f.store.admitWorkInput(input).replayed).toBe(true);
	expect(f.store.admitWorkInput(work(worldId)).replayed).toBe(true);
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.workEvidence(worldId)).toEqual(next);
	expect(reopened.admitWorkInput(input).replayed).toBe(true);
	const restricted = {
		...source,
		deliveryId: "resource-restrict",
		operation: "restrict" as const,
		policyRevision: 2,
		receipt: { ...source.receipt, grantRevision: 2 },
		fields: null,
	};
	expect(
		reopened.admitWorkInput({
			...input,
			id: restricted.deliveryId,
			source: restricted,
			payloadDigest: lifeDigest(restricted),
		}).replayed,
	).toBe(false);
	expect(
		reopened
			.workEvidence(worldId)
			.records.find((r) => r.source.kind === "resource_activity")?.source
			.fields,
	).toBeNull();
});

test("failed resource admission rolls back the history upgrade and preserves task history bytes", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { parseResourceActivitySource } = await import(
		"../src/world/work-activity-validation.ts"
	);
	const f = fixture(),
		worldId = f.request.worldId;
	f.store.admitWorkInput(work(worldId));
	const db = new DatabaseSync(f.path);
	try {
		const rows = () =>
			db.prepare("SELECT * FROM life_work_history ORDER BY revision").all();
		const before = rows(),
			prior = f.store.workEvidence(worldId);
		const source = parseResourceActivitySource({
			kind: "resource_activity",
			version: 1,
			deliveryId: "blocked",
			operation: "upsert",
			sourceDigest: lifeDigest("source"),
			policyRevision: 1,
			receipt: {
				activityId: "activity",
				activityRevision: 1,
				supersedesRevision: null,
				resourceId: "resource",
				resourceRevision: 1,
				versionId: "version",
				memoryId: null,
				actorAgentId: "lina",
				participantAgentIds: ["lina"],
				activityKind: "search",
				outcome: "recorded",
				evidenceDigest: lifeDigest([]),
				grantId: "grant",
				grantRevision: 1,
				correction: null,
			},
			fields: {
				categoryId: "research",
				outcome: "recorded",
				participantAgentIds: ["lina"],
				summary: "Search",
			},
		});
		const input = {
			version: 4 as const,
			worldId,
			id: source.deliveryId,
			sourceRevision: 1,
			payloadDigest: lifeDigest(source),
			source,
			consumedLifeRevision: null,
		};
		// A conflicting application input forces failure after the tentative upgrade.
		const application = {
			version: 1 as const,
			worldId,
			id: input.id,
			sourceRevision: 1,
			source: {
				kind: "application" as const,
				sourceId: "app",
				text: "original",
			},
			consumedLifeRevision: null,
		};
		f.store.admitLifeInput({
			...application,
			payloadDigest: lifeDigest(application.source),
		});
		expect(() => f.store.admitWorkInput(input)).toThrow("conflict");
		expect(f.store.workEvidence(worldId)).toEqual(prior);
		expect(rows()).toEqual(before);
	} finally {
		db.close();
	}
});
