import { expect, test } from "bun:test";
import { parseWorldPack } from "../src/world/authoring-validation.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

export function autonomousPack() {
	return {
		...socialPack(),
		schemaVersion: 3,
		autonomy: {
			version: 1 as const,
			needs: [
				{
					id: "curiosity",
					label: "Curiosity",
					min: 0,
					max: 10,
					initial: 1,
					driftPerStep: 1,
				},
			],
			goals: [],
			events: [],
			quietWeight: 1,
			growth: { maxNumericDelta: 1, minHabitExperiences: 2 },
		},
	};
}

test("explicit autonomous world parses without upgrading existing social packs", () => {
	const pack = autonomousPack();
	const parsed = parseWorldPack(pack);
	expect(parsed.schemaVersion).toBe(3);
	if (parsed.schemaVersion !== 3) throw Error("Expected autonomous pack");
	expect(parsed.autonomy).toEqual(pack.autonomy);
	expect(parseWorldPack(socialPack()).schemaVersion).toBe(2);
});

test("autonomous rule fields and cross references are validated", () => {
	const pack = autonomousPack();
	expect(() =>
		parseWorldPack({
			...pack,
			autonomy: { ...pack.autonomy, execute: "ignored" },
		}),
	).toThrow();
	expect(() =>
		parseWorldPack({
			...pack,
			autonomy: {
				...pack.autonomy,
				needs: [{ ...pack.autonomy.needs[0], initial: 11 }],
			},
		}),
	).toThrow();
	expect(() =>
		parseWorldPack({
			...pack,
			autonomy: {
				...pack.autonomy,
				goals: [
					{
						id: "goal",
						agentId: "missing",
						description: "Unknown owner",
						priority: 1,
						familyIds: [],
					},
				],
			},
		}),
	).toThrow();
});
