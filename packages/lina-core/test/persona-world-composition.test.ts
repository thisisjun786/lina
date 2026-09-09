import { expect, test } from "bun:test";
import type { IdentityPolicySnapshot } from "../src/world/life-types.ts";
import { projectCurrentPersona } from "../src/world/views.ts";
import { autonomySource } from "./life-autonomy-pure-fixture.ts";

function fixture() {
	const s = autonomySource();
	const personal = {
		traits: [{ axisId: "axis", value: 1 }],
		habits: [{ habitId: "habit", value: true }],
	};
	const identity: IdentityPolicySnapshot = {
		version: 2,
		profiles: s.identity.profiles.map((p) => ({
			...p,
			personalBehavior: p.agentId === "lina" ? personal : null,
			sourceStamp:
				p.agentId === "lina"
					? {
							digest: "a".repeat(64),
							receiptRevision: 1,
							profileRevision: p.profileRevision,
							definitionRevision: s.pack.life.revision,
							projectionRevision: s.pack.life.projection.revision,
						}
					: null,
		})),
	};
	const binding = {
		version: 1 as const,
		agentId: "lina",
		worldId: s.life.worldId,
		revision: 1,
		projectionPolicyRevision: s.pack.life.projection.revision,
	};
	return {
		s,
		identity,
		binding,
		read: () =>
			projectCurrentPersona(s.life, s.pack.life, binding, identity, {
				maxChars: 20000,
				maxRecords: 100,
			}),
	};
}

test("personal values compose by dimension id, seeded habits do not override, withdrawal restores LIFE", () => {
	const f = fixture();
	const first = f.read();
	expect(first?.composedBehavior.traits[0]?.value).toBe(1);
	expect(first?.composedBehavior.habits[0]?.value).toBe(true);
	const trait = f.s.life.traits.find((r) => r.agentId === "lina");
	const habit = f.s.life.habits.find((r) => r.agentId === "lina");
	if (!trait || !habit) throw Error("missingfixture");
	trait.value = 2;
	trait.profileRevision = 1;
	habit.value = false;
	habit.profileRevision = 1;
	const axis = f.s.pack.life.traits[0];
	if (!axis) throw Error("missingaxis");
	expect(f.read()?.composedBehavior.traits[0]?.value).toBe(
		Math.min(axis.max, Math.max(axis.min, 2 + 1 - axis.initial)),
	);
	expect(f.read()?.composedBehavior.habits[0]?.value).toBe(false);
	if (f.identity.version !== 2) throw Error("missingversion");
	const p = f.identity.profiles.find((p) => p.agentId === "lina");
	if (!p) throw Error("missingprofile");
	p.personalBehavior = null;
	p.sourceStamp = null;
	expect(f.read()?.composedBehavior.traits[0]?.value).toBe(2);
});

test("duplicate labels remain separate dimensions and composition cannot mutate LIFE or bypass locks", () => {
	const f = fixture();
	const firstAxis = f.s.pack.life.traits[0];
	if (!firstAxis || f.identity.version !== 2) throw Error("fixture");
	f.s.pack.life.traits.push({ ...firstAxis, id: "other" });
	f.s.pack.life.projection.sharedTraitIds.push("other");
	f.s.life.traits.push({
		agentId: "lina",
		axisId: "other",
		value: 0,
		profileRevision: null,
	});
	const profile = f.identity.profiles.find((p) => p.agentId === "lina");
	if (!profile?.personalBehavior) throw Error("fixture");
	profile.personalBehavior.traits.push({ axisId: "other", value: -1 });
	const before = JSON.stringify(f.s.life);
	expect(f.read()?.composedBehavior.traits.map((r) => r.value)).toEqual([
		1, -1,
	]);
	expect(JSON.stringify(f.s.life)).toBe(before);
	profile.lockedTraitIds.push("axis");
	expect(f.read()?.composedBehavior.traits.map((r) => r.value)).toEqual([-1]);
	profile.evolution = "manual";
	expect(f.read()?.composedBehavior).toEqual({
		traits: [],
		habits: [],
		attitudes: [],
	});
});

test("actual actor serializer consumes frozen personal values and excludes source stamps", async () => {
	const { buildLifeModelInput } = await import(
		"../src/world/autonomy-views.ts"
	);
	const { autonomyStoreFixture } = await import(
		"./life-autonomy-store-fixture.ts"
	);
	const f = autonomyStoreFixture(false);
	try {
		const identity: IdentityPolicySnapshot = {
			version: 2,
			profiles: f.request.identity.profiles.map((p) => ({
				...p,
				personalBehavior: {
					traits: [{ axisId: "axis", value: 1 }],
					habits: [],
				},
				sourceStamp: {
					digest: "b".repeat(64),
					receiptRevision: 1,
					profileRevision: p.profileRevision,
					definitionRevision: 1,
					projectionRevision: 1,
				},
			})),
		};
		const step = f.store.prepareLifeStep({ ...f.request, identity }, () => 42);
		if (!step.decision.agentId) throw Error("missingactor");
		const prompt = buildLifeModelInput(step, "director", step.decision.agentId);
		const body = JSON.parse(prompt.input);
		expect(body.sharedPersona.traits[0]?.value).toBe(1);
		expect(prompt.input).not.toContain("sourceStamp");
		expect(prompt.input).not.toContain("b".repeat(64));
	} finally {
		f.close();
	}
});

test("ordinary prompt and actor share composed values but never serialize source stamps", async () => {
	const { composePersonaPrompt } = await import("../src/agents/persona.ts");
	const { emptyDynamics } = await import("../src/agents/validation.ts");
	const f = fixture();
	const profile = f.s.profiles.find((p) => p.id === "lina");
	if (!profile) throw Error("missingprofile");
	const result = composePersonaPrompt("BASE", profile, emptyDynamics(), {
		currentPersona: f.read(),
	});
	expect(result.systemPrompt).toContain('"value":1');
	expect(result.systemPrompt).not.toContain("a".repeat(64));
	expect(result.systemPrompt).not.toContain("sourceStamp");
});
