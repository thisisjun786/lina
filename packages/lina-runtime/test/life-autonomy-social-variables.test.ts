import { expect, test } from "bun:test";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { parseSocialResolveInput } from "../../lina-core/src/world/social-resolution-validation.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { continueInput, engineInput } from "./social-fixtures/engine-input.ts";

function acceptedVariables() {
	const input = engineInput();
	return {
		...input,
		version: 2 as const,
		autonomy: {
			stepId: "life-step-1",
			worldRevision: input.world.revision,
			lifeRevision: input.life.revision,
			stateDigest: lifeDigest({ accepted: "synthetic-state" }),
			variables: { count: 7, flag: false, secret: "hidden-value" },
		},
	};
}

test("accepted variables enter the first native checkpoint and survive the next process", async () => {
	const input = acceptedVariables();
	const engine = createEnsembleSocialEngine();
	const first = await engine.resolve(input, new AbortController().signal);
	if (first.kind !== "advanced") throw Error("Expected real resolved action");
	expect(first.checkpoint.data.variables["count"]).toBe(7);
	const { autonomy: _authority, ...legacy } = input;
	const next = continueInput({ ...legacy, version: 1 }, first);
	const second = await engine.resolve(next, new AbortController().signal);
	if (second.kind !== "advanced") throw Error("Expected resumed action");
	expect(second.checkpoint.data.variables["count"]).toBe(7);
});

test("variable maps reject stale revisions, missing fields and mismatched native snapshots", () => {
	const input = acceptedVariables();
	expect(parseSocialResolveInput(input).version).toBe(2);
	expect(() =>
		parseSocialResolveInput({
			...input,
			autonomy: { ...input.autonomy, worldRevision: 9 },
		}),
	).toThrow();
	expect(() =>
		parseSocialResolveInput({
			...input,
			autonomy: { ...input.autonomy, variables: { count: 7 } },
		}),
	).toThrow();
	expect(() =>
		parseSocialResolveInput({
			...input,
			autonomy: {
				...input.autonomy,
				variables: { ...input.autonomy.variables, count: 99 },
			},
		}),
	).toThrow();
});
