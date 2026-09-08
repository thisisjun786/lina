import { afterEach, expect, test } from "bun:test";
import { parseLifeConfigInput } from "../src/world/authoring-request-validation.ts";
import { WorldStore } from "../src/world/store.ts";
import { unconfigured } from "./life-authoring-fixture.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});

function rule(familyId: string) {
	return {
		id: "work-context",
		familyId,
		categoryId: "research",
		outcomes: ["turn_ended" as const],
		attribution: "participant" as const,
		weight: 4,
		requiredMatch: false,
	};
}
test("work config is explicitly versioned and unset preserves the exact v1 contract", () => {
	const old = unconfigured();
	expect(parseLifeConfigInput(old)).toEqual(old);
	const next = { ...old, version: 2 as const, work: null };
	expect(parseLifeConfigInput(next)).toEqual(next);
	expect(() => parseLifeConfigInput({ ...old, work: null })).toThrow();
	const { work: _work, ...missing } = next;
	expect(() => parseLifeConfigInput(missing)).toThrow();
	const selected = { ...next, work: { rules: [rule("meeting")] } };
	expect(parseLifeConfigInput(selected)).toEqual(selected);
	for (const bad of [
		{ weight: Infinity },
		{ attribution: "mentioned" },
		{ outcomes: ["success"] },
		{ requiredMatch: "true" },
		{ categoryId: "" },
	])
		expect(() =>
			parseLifeConfigInput({
				...next,
				work: { rules: [{ ...rule("meeting"), ...bad }] },
			}),
		).toThrow();
});

test("persists work settings and rejects unknown families before changing configuration", () => {
	const fixture = autonomyStoreFixture(false);
	cleanup.push(() => fixture.close());
	const familyId = fixture.source.pack.eventFamilies[0]?.id;
	if (!familyId) throw Error("Missing fixture event family");
	const { worldId, revision, ...old } = fixture.store.lifeConfig(
		fixture.request.worldId,
	);
	const next = parseLifeConfigInput({
		...old,
		version: 2,
		work: { rules: [rule(familyId)] },
	});
	const saved = fixture.store.setLifeConfig(worldId, revision, next);
	expect(saved.version).toBe(2);
	expect(() =>
		fixture.store.setLifeConfig(
			worldId,
			saved.revision,
			parseLifeConfigInput({ ...next, work: { rules: [rule("missing")] } }),
		),
	).toThrow(/work|family/i);
	expect(fixture.store.lifeConfig(worldId)).toEqual(saved);
	fixture.store.close();
	const reopened = new WorldStore(fixture.path, fixture.clock);
	cleanup.push(() => reopened.close());
	expect(reopened.lifeConfig(worldId)).toEqual(saved);
});
