import { expect, test } from "bun:test";
import type {
	FrozenVisualIdentity,
	VisualPurpose,
} from "../src/agents/visual.ts";
import { freezeLifeImageMaterial } from "../src/world/image-brief.ts";
import { required } from "./life-fixture.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";

function visual(
	agentId = "lina",
	purpose: VisualPurpose = { kind: "avatar" },
): FrozenVisualIdentity {
	return {
		agentId,
		profileRevision: 1,
		visualRevision: 1,
		avatarPolicyRevision: 1,
		anchors: ["short blue hair"],
		textIdentity: "Resident portrait",
		reference: null,
		grants: [{ grantId: `grant-${agentId}`, revision: 1, purpose }],
	};
}

test("avatar brief contains approved visual identity only and freezes caller material", () => {
	const input = visual();
	const result = freezeLifeImageMaterial({
		purpose: { kind: "avatar" },
		publication: null,
		visuals: [input],
	});
	expect(result.prompt).toContain("short blue hair");
	expect(result.prompt).toContain("Resident portrait");
	expect(result.prompt).not.toContain("grant-lina");
	expect(result.prompt).not.toContain("visualRevision");
	expect(result.altText).toBe("Agent portrait");
	input.anchors[0] = "later private edit";
	expect(result.visuals[0]?.anchors).toEqual(["short blue hair"]);
});

test("missing purpose or missing approved identity cannot become an image brief", () => {
	const wrong = visual("lina", {
		kind: "life",
		worldId: "world",
		recipientId: "friends",
	});
	expect(() =>
		freezeLifeImageMaterial({
			purpose: { kind: "avatar" },
			publication: null,
			visuals: [wrong],
		}),
	).toThrow();
	const empty = visual();
	empty.textIdentity = null;
	expect(() =>
		freezeLifeImageMaterial({
			purpose: { kind: "avatar" },
			publication: null,
			visuals: [empty],
		}),
	).toThrow();
	expect(() =>
		freezeLifeImageMaterial({
			purpose: { kind: "avatar" },
			publication: null,
			visuals: [],
		}),
	).toThrow();
});

test("multiple identity references are explicitly unsupported before generation", () => {
	const f = publishedImageFixture(false, "Residents met.", true);
	const purpose = {
		kind: "life" as const,
		worldId: "test-world",
		recipientId: "friends",
	};
	const visuals = [visual("lina", purpose), visual("mira", purpose)].map(
		(value) => ({
			...value,
			reference: {
				version: 1 as const,
				id: `ref-${value.agentId}`,
				agentId: value.agentId,
				assetId: `asset-${value.agentId}`,
				sha256: "a".repeat(64),
				mime: "image/png" as const,
				size: 42,
				origin: { kind: "upload" as const },
			},
		}),
	);
	try {
		const publication = f.store.publishedImageMaterial(
			"test-world",
			f.postId,
			"lina",
			"friends",
		);
		expect(publication?.scene?.occupants).toContain("mira");
		expect(() =>
			freezeLifeImageMaterial({ purpose, publication, visuals }),
		).toThrow("unsupported_image_references");
	} finally {
		f.store.close();
	}
});

test("visual provenance changes keep content fingerprint but never overwrite frozen brief digest", () => {
	const first = freezeLifeImageMaterial({
		purpose: { kind: "avatar" },
		publication: null,
		visuals: [visual()],
	});
	const changed = visual();
	changed.visualRevision = 2;
	required(changed.grants[0]).revision = 2;
	const second = freezeLifeImageMaterial({
		purpose: { kind: "avatar" },
		publication: null,
		visuals: [changed],
	});
	expect(second.fingerprint).toBe(first.fingerprint);
	expect(second.digest).not.toBe(first.digest);
	changed.textIdentity = "A different appearance";
	expect(
		freezeLifeImageMaterial({
			purpose: { kind: "avatar" },
			publication: null,
			visuals: [changed],
		}).fingerprint,
	).not.toBe(first.fingerprint);
});
