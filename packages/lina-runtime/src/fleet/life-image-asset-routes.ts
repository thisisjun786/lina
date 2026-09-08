import {
	hash,
	inspectContent,
} from "../../../lina-core/src/attachments/validation.ts";
import { identifier } from "../../../lina-core/src/world/life-json.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { FleetLifeImages } from "./life-images.ts";

const MAX_URL_LENGTH = 4096;
const BEARER = /^Bearer llv1_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface LifeImageAssetRouteServices {
	/** Resolves only durable world state; this route never starts execution. */
	store(): WorldStore;
	/** May create a storage-only image facade, never a client, lease or scheduler. */
	images(): FleetLifeImages;
	assertSourceCurrent(worldId: string): void;
}

function response(status: number, text: string): Response {
	return new Response(text, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function notFound(): Response {
	return response(404, "Not found");
}

/** Viewer-scoped image bytes. It only asks the image facade after current publication authority succeeds. */
export function lifeImageAssetRoutes(
	request: Request,
	services: LifeImageAssetRouteServices,
): Response | undefined {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return response(403, "Forbidden");
	}
	const parts = url.pathname.split("/");
	if (
		parts[1] !== "api" ||
		parts[2] !== "life" ||
		parts[3] !== "worlds" ||
		parts[5] !== "feed" ||
		parts[6] !== "posts" ||
		parts[8] !== "assets"
	)
		return;
	if (
		parts.length !== 10 ||
		request.url.length > MAX_URL_LENGTH ||
		url.search ||
		url.hash ||
		/[%\\]/.test(url.pathname) ||
		request.url.includes("\\")
	)
		return notFound();
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host ||
		url.username ||
		url.password
	)
		return response(403, "Forbidden");
	if (request.method !== "GET")
		return new Response("Method not allowed", {
			status: 405,
			headers: {
				Allow: "GET",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	const authorization = request.headers.get("authorization");
	if (!authorization || !BEARER.test(authorization))
		return response(403, "Forbidden");
	const length = request.headers.get("content-length");
	if (
		request.headers.has("content-encoding") ||
		request.body !== null ||
		(length !== null && (!/^\d+$/.test(length) || Number(length) !== 0))
	)
		return response(400, "Invalid request");
	let worldId: string, postId: string, assetId: string;
	try {
		worldId = identifier(parts[4]);
		postId = identifier(parts[7]);
		assetId = parts[9] ?? "";
		if (!UUID.test(assetId)) return notFound();
	} catch {
		return notFound();
	}
	try {
		const store = services.store();
		const grant = store.authenticatePublicationViewer(
			worldId,
			authorization.slice(7),
		);
		if (!grant) return response(403, "Forbidden");
		services.assertSourceCurrent(worldId);
		if (
			!store.publicationPost(
				worldId,
				{ kind: "viewer", grantId: grant.id },
				postId,
			)
		)
			return notFound();
		const pointer = store.imagePostAsset(worldId, postId, grant.recipientId);
		if (!pointer || pointer.artifactId !== assetId) return notFound();
		const asset = services
			.images()
			.posts.asset(worldId, postId, grant.recipientId);
		if (
			!asset ||
			asset.mime !== pointer.mime ||
			asset.etag !== pointer.sha256 ||
			!SHA256.test(asset.etag) ||
			hash(asset.bytes) !== asset.etag ||
			inspectContent(
				`life-image-${assetId}.${asset.mime === "image/png" ? "png" : "jpg"}`,
				asset.bytes,
			) !== asset.mime
		)
			return notFound();
		return new Response(asset.bytes, {
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Type": asset.mime,
				"Content-Disposition": `inline; filename="life-image-${assetId}.${asset.mime === "image/png" ? "png" : "jpg"}"`,
				ETag: `"${asset.etag}"`,
			},
		});
	} catch {
		return notFound();
	}
}
