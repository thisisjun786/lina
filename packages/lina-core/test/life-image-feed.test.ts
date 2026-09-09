import { expect, test } from "bun:test";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";

test("authorized image metadata decorates feed content and invalidates an old cursor without changing the post", () => {
	const f = publishedImageFixture();
	try {
		const { grant } = f.store.mintPublicationViewer("test-world", {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: grant.id };
		f.store.replyToPublication("test-world", principal, f.postId, {
			requestKey: "another-post",
			expectedPostRevision: 1,
			text: "Hello",
		});
		const before = f.store.publicationPost("test-world", principal, f.postId);
		const page = f.store.publicationFeed("test-world", principal, {
			limit: 1,
			after: null,
		});
		expect(page.nextCursor).not.toBeNull();
		const images = new Map([
			[
				f.postId,
				{
					artifactId: "00000000-0000-4000-8000-000000000001",
					attachmentVersion: 1,
					mime: "image/png" as const,
					size: 12,
					altText: "At the cafe",
					url: `/api/life/worlds/test-world/feed/posts/${f.postId}/assets/00000000-0000-4000-8000-000000000001`,
				},
			],
		]);
		const decorated = f.store.publicationPost(
			"test-world",
			principal,
			f.postId,
			images,
		);
		expect(decorated?.image).toEqual(images.get(f.postId));
		expect(decorated?.revision).toBe(before?.revision);
		expect(decorated?.segments).toEqual(before?.segments);
		expect(() =>
			f.store.publicationFeed(
				"test-world",
				principal,
				{ limit: 1, after: page.nextCursor },
				images,
			),
		).toThrow(/cursor scope changed/);
		expect(f.store.publicationPost("test-world", principal, f.postId)).toEqual(
			before,
		);
	} finally {
		f.store.close();
	}
});
