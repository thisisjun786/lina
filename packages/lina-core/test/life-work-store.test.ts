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
