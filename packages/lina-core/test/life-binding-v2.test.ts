import { afterEach, expect, test } from "bun:test";
import {
	parseBindingSelection,
	parseWorldBinding,
} from "../src/world/life-validation.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput } from "./life-work-fixture.ts";

const close: Array<() => void> = [];
afterEach(() => {
	for (const fn of close.splice(0).reverse()) fn();
});
test("an explicit ordinary recipient binding is versioned and survives reopen; v1 grants no recipient", () => {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const worldId = f.request.worldId;
	const old = f.store.setWorldBinding("lina", 0, {
		worldId,
		projectionPolicyRevision: 1,
	});
	expect(old.version).toBe(1);
	expect(old).not.toHaveProperty("conversationRecipientId");
	const next = f.store.setWorldBinding("lina", old.revision, {
		version: 2,
		worldId,
		projectionPolicyRevision: 1,
		conversationRecipientId: "owner",
	});
	expect(next.version).toBe(2);
	f.store.close();
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.worldBinding("lina")).toEqual(next);
	expect(() =>
		parseWorldBinding({ ...old, conversationRecipientId: "owner" }),
	).toThrow();
	expect(() =>
		parseBindingSelection({
			version: 2,
			worldId: null,
			projectionPolicyRevision: 0,
			conversationRecipientId: "owner",
		}),
	).toThrow();
	expect(() =>
		parseBindingSelection({ version: 2, worldId, projectionPolicyRevision: 1 }),
	).toThrow();
	expect(
		parseBindingSelection({
			version: 2,
			worldId: null,
			projectionPolicyRevision: 0,
			conversationRecipientId: null,
		}),
	).toMatchObject({ version: 2, conversationRecipientId: null });
});

test("work permission changes advance native binding authority while duplicate delivery preserves it", () => {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const worldId = f.request.worldId;
	const bound = f.store.setWorldBinding("lina", 0, {
		version: 2,
		worldId,
		projectionPolicyRevision: 1,
		conversationRecipientId: "owner",
	});
	const { worldId: _id, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		version: 2,
		work: {
			rules: [
				{
					id: "work",
					familyId: "meet",
					categoryId: "research",
					outcomes: [],
					attribution: "owner",
					weight: 1,
					requiredMatch: false,
				},
			],
		},
	});
	const configured = f.store.worldBinding("lina");
	expect(configured?.revision).toBeGreaterThan(bound.revision);
	f.store.admitWorkInput(workInput(worldId));
	const admitted = f.store.worldBinding("lina");
	expect(admitted?.revision).toBeGreaterThan(configured?.revision ?? 0);
	f.store.admitWorkInput(workInput(worldId));
	expect(f.store.worldBinding("lina")).toEqual(admitted);
	f.store.admitWorkInput(workInput(worldId, 2, true));
	expect(f.store.worldBinding("lina")?.revision).toBeGreaterThan(
		admitted?.revision ?? 0,
	);
	expect(f.store.worldBinding("lina")).toMatchObject({
		version: 2,
		conversationRecipientId: "owner",
		projectionPolicyRevision: 1,
	});
});
