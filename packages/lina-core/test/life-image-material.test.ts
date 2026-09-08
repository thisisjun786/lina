import { expect, test } from "bun:test";
import { publishedImageFixture as published } from "./life-image-publication-fixture.ts";

test("image material takes only actually rendered supported claims and separately permitted scene", () => {
	const f = published();
	try {
		const material = f.store.publishedImageMaterial(
			"test-world",
			f.postId,
			"lina",
			"friends",
		);
		expect(material?.claims).toEqual([
			{ kind: "world_event", text: "Residents met at the cafe." },
		]);
		expect(material?.scene).toBeNull();
		expect(material?.source).toMatchObject({
			kind: "event_post",
			publicationId: f.postId,
			postRevision: 1,
			eventId: "test-world:1",
			recipientId: "friends",
		});
		expect(JSON.stringify(material)).not.toContain("secret dragon");
		expect(JSON.stringify(material)).not.toContain("The key is red");
		expect(
			f.store.publishedImageMaterial("test-world", f.postId, "mira", "friends"),
		).toBeNull();
		expect(
			f.store.publishedImageMaterial("test-world", f.postId, "lina", "public"),
		).toBeNull();
	} finally {
		f.store.close();
	}
});

test("imagination without supported claims or permitted scene cannot become image fact", () => {
	const f = published(true);
	try {
		expect(
			f.store.publishedImageMaterial("test-world", f.postId, "lina", "friends"),
		).toBeNull();
	} finally {
		f.store.close();
	}
});

test("withdrawn post and user reply never expose retained full world image material", () => {
	const f = published();
	try {
		const viewer = f.store.mintPublicationViewer("test-world", {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const reply = f.store.replyToPublication(
			"test-world",
			{ kind: "viewer", grantId: viewer.grant.id },
			f.postId,
			{ requestKey: "reply", expectedPostRevision: 1, text: "I saw a dragon." },
		);
		expect(
			f.store.publishedImageMaterial(
				"test-world",
				reply.postId ?? "missing",
				"lina",
				"friends",
			),
		).toBeNull();
		f.store.withdrawPublicationPost("test-world", f.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			f.store.publishedImageMaterial("test-world", f.postId, "lina", "friends"),
		).toBeNull();
	} finally {
		f.store.close();
	}
});
