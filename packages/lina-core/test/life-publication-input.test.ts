import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import type { LifeInputV3 } from "../src/world/life-types.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import type {
	PublicationEvidenceSnapshot,
	PublicationInputSource,
} from "../src/world/publication-input.ts";
import {
	parsePublicationEvidence,
	publicationObservationId,
} from "../src/world/publication-input.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

function input(): LifeInputV3 {
	const id = publicationObservationId("test-world", "interaction", "lina");
	const source: PublicationInputSource = {
		kind: "publication_interaction",
		observationId: id,
		interactionId: "interaction",
		postId: "post",
		postRevision: 1,
		principal: { kind: "viewer", grantId: "grant" },
		recipientAgentId: "lina",
		action: { kind: "reply", text: "I enjoyed that story." },
		roots: [{ rootId: "root", depth: 1 }],
	};
	return {
		version: 3,
		worldId: "test-world",
		id,
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
}

test("publication feedback has a strict scoped v3 input and never widens generic application admission", () => {
	const value = input();
	expect(parseLifeInput(value)).toEqual(value);
	const store = publicationStoreFixture();
	try {
		expect(() => store.admitLifeInput(parseLifeInput(value))).toThrow(
			"Trusted",
		);
		expect(store.lifeInputs("test-world")).toEqual([]);
	} finally {
		store.close();
	}
	for (const patch of [
		{ id: "forged" },
		{ sourceRevision: 2 },
		{ payloadDigest: "a".repeat(64) },
		{ source: { ...value.source, recipientId: "all" } },
		{
			source: {
				...value.source,
				principal: { kind: "viewer", grantId: "grant", agentId: "lina" },
			},
		},
		{ source: { ...value.source, roots: [] } },
	]) {
		const changed = { ...value, ...patch };
		if ("source" in patch) changed.payloadDigest = lifeDigest(changed.source);
		expect(() => parseLifeInput(changed)).toThrow();
	}
});
test("frozen publication evidence binds each observation to one world and recipient without importing raw task data", () => {
	const value = input(),
		evidence: PublicationEvidenceSnapshot = {
			version: 1,
			worldId: "test-world",
			revision: 1,
			permissionDigest: lifeDigest({ scope: "permitted" }),
			authority: {
				settingsRevision: 1,
				posts: [{ id: "post", kind: "post", revision: 1 }],
				grants: [{ id: "grant", revision: 1 }],
			},
			records: [{ inputId: value.id, source: value.source }],
		};
	expect(parsePublicationEvidence(evidence)).toEqual(evidence);
	const { authority: _authority, ...missingAuthority } = evidence;
	expect(() => parsePublicationEvidence(missingAuthority)).toThrow();
	expect(() =>
		parsePublicationEvidence({ ...evidence, worldId: "other" }),
	).toThrow();
	expect(() =>
		parsePublicationEvidence({
			...evidence,
			records: [...evidence.records, ...evidence.records],
		}),
	).toThrow();
	expect(() =>
		parsePublicationEvidence({
			...evidence,
			revision: Number.MAX_SAFE_INTEGER + 1,
		}),
	).toThrow();
	expect(() =>
		parsePublicationEvidence({ ...evidence, rawTaskBody: "secret" }),
	).toThrow();
});
