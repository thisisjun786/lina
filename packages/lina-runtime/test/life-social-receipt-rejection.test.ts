import { expect, test } from "bun:test";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../../lina-core/src/world/social-codec.ts";
import { socialPredicateCategory } from "../../lina-core/src/world/social-views.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { identityPolicy } from "../../lina-core/test/life-fixture.ts";
import {
	activateSocialPack,
	socialRequest,
} from "../../lina-core/test/life-social-store-fixture.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";

test("a forged declared arithmetic result cannot be saved or poison the valid receipt", async () => {
	const store = activateSocialPack(new WorldStore(":memory:"));
	try {
		const prepared = store.prepareSocialResolution(
			socialRequest(),
			() => 123456,
		);
		if ("kind" in prepared.input) throw Error("Unexpected extension");
		const original = await createEnsembleSocialEngine().resolve(
			prepared.input,
			new AbortController().signal,
		);
		if (original.kind !== "advanced")
			throw Error("Missing real advanced result");
		for (const value of [-1, 2, 0]) {
			const forged = structuredClone(original);
			const history = decodeSocialValue(forged.checkpoint.data.state.history);
			if (!Array.isArray(history)) throw Error("Missing history");
			const slice = history[forged.checkpoint.data.state.step];
			if (!Array.isArray(slice)) throw Error("Missing current history slice");
			for (const row of slice as Array<Record<string, unknown>>)
				if (
					row["category"] === socialPredicateCategory("trust") &&
					row["first"] === "lina" &&
					row["second"] === "mira"
				)
					row["value"] = value;
			for (const effect of forged.effects)
				if (
					effect.kind === "predicate" &&
					effect.predicateId === "trust" &&
					effect.firstAgentId === "lina" &&
					effect.secondAgentId === "mira"
				)
					effect.next = value;
			if (value === 0)
				forged.effects = forged.effects.filter(
					(effect) => effect.kind !== "predicate",
				);
			forged.checkpoint.data.state.history = encodeSocialValue(history);
			forged.checkpoint.dataDigest = lifeDigest(forged.checkpoint.data);
			const { resultDigest: _digest, ...body } = forged;
			forged.resultDigest = lifeDigest(body);
			expect(() => {
				store.finishSocialResolution("test-world", "request-1", forged);
			}).toThrow();
			expect(
				store.socialResolution("test-world", "request-1").result,
			).toBeNull();
			expect(store.lifeSnapshot("test-world").revision).toBe(0);
		}
		store.finishSocialResolution("test-world", "request-1", original);
		const receipt = store.acceptSocialResolution(
			"test-world",
			"request-1",
			identityPolicy(),
		);
		expect(receipt.lifeRevision).toBe(1);
		expect(
			store
				.lifeSnapshotAt("test-world", 1)
				.attitudes.find(
					(x) => x.fromAgentId === "lina" && x.toAgentId === "mira",
				)?.value,
		).toBe(1);
	} finally {
		store.close();
	}
});
