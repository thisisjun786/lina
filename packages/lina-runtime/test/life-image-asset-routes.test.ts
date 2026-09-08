import { afterEach, expect, mock, test } from "bun:test";
import { hash } from "../../lina-core/src/attachments/validation.ts";
import type { PostImageAsset } from "../../lina-core/src/world/image-publication.ts";
import { publishedImageFixture } from "../../lina-core/test/life-image-publication-fixture.ts";
import { lifeImageAssetRoutes } from "../src/fleet/life-image-asset-routes.ts";
import type { FleetLifeImages } from "../src/fleet/life-images.ts";
import { png } from "./ima2-client-fixture.ts";

const WORLD = "test-world";
const ASSET = "550e8400-e29b-41d4-a716-446655440000";
const PNG = new Uint8Array(png);
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
	const f = publishedImageFixture();
	const etag = hash(PNG);
	cleanups.push(() => f.store.close());
	const issued = f.store.mintPublicationViewer(WORLD, {
		requestKey: "asset-viewer",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	});
	if (!issued.token) throw Error("Missing synthetic token");
	const imagePostAsset = mock(
		(
			_worldId: string,
			_postId: string,
			recipientId: string,
		): PostImageAsset | null =>
			recipientId === "friends"
				? {
						kind: "post",
						receiptId: "receipt",
						postId: f.postId,
						postRevision: 1,
						artifactId: ASSET,
						sha256: etag,
						mime: "image/png",
						size: PNG.byteLength,
						altText: "A permitted scene",
						attachmentVersion: 1,
					}
				: null,
	);
	f.store.imagePostAsset = imagePostAsset;
	const asset = mock(() => ({
		bytes: PNG,
		mime: "image/png" as const,
		etag,
		altText: "A permitted scene",
	}));
	const images = mock(
		() => ({ posts: { asset } }) as unknown as FleetLifeImages,
	);
	const assertSourceCurrent = mock(() => {});
	const url = `http://127.0.0.1:4010/api/life/worlds/${WORLD}/feed/posts/${f.postId}/assets/${ASSET}`;
	return {
		f,
		asset,
		images,
		imagePostAsset,
		assertSourceCurrent,
		request: (token = issued.token, suffix = "", init: RequestInit = {}) =>
			lifeImageAssetRoutes(
				new Request(url + suffix, {
					...init,
					headers: {
						host: "127.0.0.1:4010",
						...(token ? { authorization: `Bearer ${token}` } : {}),
						...init.headers,
					},
				}),
				{ store: () => f.store, images, assertSourceCurrent },
			),
	};
}

test("serves only the current viewer's exact verified image asset", () => {
	const f = fixture();
	const response = f.request();
	expect(response?.status).toBe(200);
	expect(response?.headers.get("content-type")).toBe("image/png");
	expect(response?.headers.get("etag")).toBe(`"${hash(PNG)}"`);
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response?.headers.get("content-disposition")).toBe(
		`inline; filename="life-image-${ASSET}.png"`,
	);
	expect(f.assertSourceCurrent).toHaveBeenCalledWith(WORLD);
	expect(f.imagePostAsset).toHaveBeenCalledWith(WORLD, f.f.postId, "friends");
	expect(f.asset).toHaveBeenCalledWith(WORLD, f.f.postId, "friends");
});

test("serves the handler through a real loopback request with an actual WorldStore grant", async () => {
	const f = fixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return (
				lifeImageAssetRoutes(request, {
					store: () => f.f.store,
					images: f.images,
					assertSourceCurrent: f.assertSourceCurrent,
				}) ?? new Response("Not found", { status: 404 })
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const issued = f.f.store.mintPublicationViewer(WORLD, {
		requestKey: "loopback-viewer",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	});
	if (!issued.token) throw Error("Missing loopback token");
	const response = await fetch(
		`http://127.0.0.1:${server.port}/api/life/worlds/${WORLD}/feed/posts/${f.f.postId}/assets/${ASSET}`,
		{ headers: { authorization: `Bearer ${issued.token}` } },
	);
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
	expect(response.headers.get("content-type")).toBe("image/png");
});

test("denies missing, forged and malformed asset requests before image storage", () => {
	const f = fixture();
	expect(f.request("")?.status).toBe(403);
	expect(f.request(`llv1_${"b".repeat(43)}`)?.status).toBe(403);
	expect(f.request(undefined, "?x=1")?.status).toBe(404);
	expect(f.request(undefined, `/${ASSET}`)?.status).toBe(404);
	expect(f.images).not.toHaveBeenCalled();
	expect(f.asset).not.toHaveBeenCalled();
});

test("an ownerless post image association denies before image storage", () => {
	const f = fixture();
	f.f.store.imagePostAsset = mock(() => null);
	expect(f.request()?.status).toBe(404);
	expect(f.images).not.toHaveBeenCalled();
});
