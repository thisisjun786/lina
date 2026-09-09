import {
	flag,
	identifier,
	jsonBoundary,
	revision,
} from "../../../lina-core/src/world/life-json.ts";
import type {
	PublicationPrincipal,
	PublicationRun,
	PublicationRunInput,
	PublicLifeImage,
} from "../../../lina-core/src/world/publication-types.ts";
import { parsePublicationSettings } from "../../../lina-core/src/world/publication-validation.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import {
	fields,
	MAX_WORLD_BYTES,
	text,
} from "../../../lina-core/src/world/validation.ts";
import { assertWorkSourceCurrent } from "../life/work-source.ts";
import { ModelRequestError } from "../models/errors.ts";

export interface PublicationRouteServices {
	/** Resolve current installation ownership without starting a runner/scheduler. */
	store(): WorldStore;
	run(
		worldId: string,
		input: PublicationRunInput,
		signal: AbortSignal,
	): Promise<PublicationRun>;
	/** Queue a scheduler wake only; never execute a model from this callback. */
	changed?(worldId: string): void;
	/** Read source-side authority without creating a model, bridge or scheduler. */
	assertSourceCurrent?(worldId: string): void;
	/** Storage-only cross-store image projection, computed before the feed transaction. */
	images?(
		worldId: string,
		principal: PublicationPrincipal,
		postIds: readonly string[],
	): ReadonlyMap<string, PublicLifeImage>;
}

function currentSource(
	services: PublicationRouteServices,
	store: WorldStore,
	worldId: string,
): void {
	if (services.assertSourceCurrent) services.assertSourceCurrent(worldId);
	else assertWorkSourceCurrent(undefined, store.workEvidence(worldId));
}

const MAX_URL_LENGTH = 4096;
const MAX_CURSOR_LENGTH = 2048;
const BEARER = /^Bearer llv1_[A-Za-z0-9_-]{43}$/;
type Action =
	| "settings"
	| "mint"
	| "revoke"
	| "run"
	| "job"
	| "retry"
	| "withdraw"
	| "feed"
	| "post"
	| "cursor"
	| "replies"
	| "reactions"
	| "reshares";
type InteractionAction = Extract<Action, "replies" | "reactions" | "reshares">;
type InteractionResult = ReturnType<WorldStore["replyToPublication"]>;
const interactionAction = (
	action: string | undefined,
): action is InteractionAction =>
	action === "replies" || action === "reactions" || action === "reshares";
interface Route {
	worldId: string;
	action: Action;
	target: string;
}
const METHODS: Record<Action, readonly string[]> = {
	settings: ["GET", "PUT"],
	mint: ["POST"],
	revoke: ["POST"],
	run: ["POST"],
	job: ["GET"],
	retry: ["POST"],
	withdraw: ["POST"],
	feed: ["GET"],
	post: ["GET"],
	cursor: ["GET", "PUT"],
	replies: ["POST"],
	reactions: ["PUT"],
	reshares: ["POST"],
};
const reply = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
function failure(status: 400 | 403 | 404 | 409) {
	const messages = {
		400: "Invalid publication request",
		403: "Forbidden",
		404: "Not found",
		409: "Publication state changed; reload the exact revision",
	};
	return reply({ error: messages[status] }, status);
}

function matchRoute(parts: string[]): Route | undefined {
	const worldId = identifier(parts[4]);
	const section = parts[5],
		item = parts[6],
		target = parts[7] ?? "",
		operation = parts[8];
	if (section === "feed") {
		if (parts.length === 6) return { worldId, action: "feed", target };
		if (parts.length === 7 && item === "cursor")
			return { worldId, action: "cursor", target };
		if (parts.length === 8 && item === "posts")
			return { worldId, action: "post", target: identifier(target) };
		if (parts.length === 9 && item === "posts" && interactionAction(operation))
			return { worldId, action: operation, target: identifier(target) };
	} else if (section === "publication") {
		if (parts.length === 7) {
			if (item === "settings" || item === "run")
				return { worldId, action: item, target };
			if (item === "viewers") return { worldId, action: "mint", target };
		}
		if (parts.length === 8 && item === "jobs")
			return { worldId, action: "job", target: identifier(target) };
		if (parts.length === 9) {
			identifier(target);
			if (item === "viewers" && operation === "revoke")
				return { worldId, action: "revoke", target };
			if (item === "jobs" && operation === "retry")
				return { worldId, action: "retry", target };
			if (item === "posts" && operation === "withdraw")
				return { worldId, action: "withdraw", target };
		}
	}
}

function feedQuery(
	url: URL,
	action: Action,
): { limit: number; after: string | null } {
	if (
		url.search &&
		(action !== "feed" ||
			!/^\?(?:after|limit)=[A-Za-z0-9_-]+(?:&(?:after|limit)=[A-Za-z0-9_-]+)?$/.test(
				url.search,
			))
	)
		throw Error("Invalid query");
	for (const key of url.searchParams.keys()) {
		if (url.searchParams.getAll(key).length !== 1)
			throw Error("Duplicate query");
	}
	const limit = url.searchParams.get("limit"),
		after = url.searchParams.get("after");
	if (limit !== null && !/^(?:[1-9][0-9]?|100)$/.test(limit))
		throw Error("Invalid limit");
	if (
		after !== null &&
		(after.length > MAX_CURSOR_LENGTH || /llv1_[A-Za-z0-9_-]{43}/.test(after))
	)
		throw Error("Invalid cursor");
	return { limit: limit === null ? 100 : Number(limit), after };
}

function checkBodyHeaders(request: Request): void {
	const length = request.headers.get("content-length"),
		read = request.method === "GET";
	if (
		request.headers.has("content-encoding") ||
		(length !== null &&
			(!/^\d+$/.test(length) || Number(length) > MAX_WORLD_BYTES))
	)
		throw Error("Invalid body headers");
	if (read) {
		if (request.body !== null || (length !== null && Number(length) !== 0))
			throw Error("Unexpected read body");
	} else if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
		"application/json"
	)
		throw Error("Invalid body type");
}

/** Prepare only typed arguments here; invoke the storage factory after the JSON await. */
function mutation(
	route: Route,
	body: unknown,
	changed: () => void,
): (store: WorldStore, principal: PublicationPrincipal | null) => unknown {
	const { worldId, target, action } = route;
	jsonBoundary(body);
	if (action === "settings") {
		fields(body, ["expectedRevision", "settings"]);
		const expected = revision(body.expectedRevision),
			settings = parsePublicationSettings(body.settings);
		return (store) => {
			const result = store.setPublicationSettings(worldId, expected, settings);
			if (result.revision > expected) changed();
			return result;
		};
	}
	if (action === "mint") {
		fields(body, ["requestKey", "expectedSettingsRevision", "recipientId"]);
		const input = {
			requestKey: identifier(body.requestKey),
			expectedSettingsRevision: revision(body.expectedSettingsRevision, 1),
			recipientId: identifier(body.recipientId),
		};
		return (store) => store.mintPublicationViewer(worldId, input);
	}
	if (action === "cursor") {
		fields(body, ["expectedRevision", "postId"]);
		const input = {
			expectedRevision: revision(body.expectedRevision),
			postId: identifier(body.postId),
		};
		return (store, principal) => {
			if (!principal) throw Error("Publication principal forbidden");
			return store.setPublicationReadCursor(worldId, principal, input);
		};
	}
	fields(body, ["requestKey", "expectedRevision"]);
	const input = {
		requestKey: identifier(body.requestKey),
		expectedRevision: revision(body.expectedRevision, 1),
	};
	if (action === "revoke")
		return (store) => {
			const result = store.revokePublicationViewer(worldId, target, input);
			if (!result.replayed && result.grant.revision > input.expectedRevision)
				changed();
			return result;
		};
	if (action === "retry")
		return (store) => {
			const before = store.publicationJob(worldId, target).revision;
			const result = store.retryPublicationJob(worldId, target, input);
			if (result.revision > before) changed();
			return result;
		};
	if (action === "withdraw")
		// This port returns no effective/replayed marker; do not notify on guesses.
		return (store) => store.withdrawPublicationPost(worldId, target, input);
	throw Error("Invalid mutation");
}

function interactionMutation(route: Route, body: unknown) {
	jsonBoundary(body);
	const { worldId, target, action } = route;
	const extra =
		action === "replies"
			? ["text"]
			: action === "reactions"
				? ["reactionId", "active"]
				: [];
	fields(body, ["requestKey", "expectedPostRevision", ...extra]);
	const input = {
		requestKey: identifier(body["requestKey"]),
		expectedPostRevision: revision(body["expectedPostRevision"], 1),
	};
	if (action === "replies") {
		const value = body["text"];
		text(value, "publication reply");
		return (store: WorldStore, principal: PublicationPrincipal) =>
			store.replyToPublication(worldId, principal, target, {
				...input,
				text: value,
			});
	}
	if (action === "reactions") {
		const reactionId = identifier(body["reactionId"]),
			active = flag(body["active"]);
		return (store: WorldStore, principal: PublicationPrincipal) =>
			store.reactToPublication(worldId, principal, target, {
				...input,
				reactionId,
				active,
			});
	}
	return (store: WorldStore, principal: PublicationPrincipal) =>
		store.resharePublication(worldId, principal, target, input);
}

function viewerPrincipal(
	store: WorldStore,
	worldId: string,
	authorization: string | null,
): PublicationPrincipal | null {
	const grant = store.authenticatePublicationViewer(
		worldId,
		authorization?.slice(7) ?? "",
	);
	return grant ? { kind: "viewer", grantId: grant.id } : null;
}

function interactionResponse(
	route: Route,
	result: InteractionResult,
	services: PublicationRouteServices,
	authorization: string | null,
): Response {
	if (result.effective && !result.replayed) services.changed?.(route.worldId);
	// Re-resolve installation ownership, token eligibility and public projection after mutation/wake.
	const store = services.store(),
		principal = viewerPrincipal(store, route.worldId, authorization);
	if (!principal) return failure(403);
	currentSource(services, store, route.worldId);
	if (!store.publicationPost(route.worldId, principal, route.target))
		return failure(404);
	const post = result.postId
		? store.publicationPost(route.worldId, principal, result.postId)
		: null;
	if (result.postId && !post) return failure(404);
	return reply({
		post,
		effective: result.effective,
		replayed: result.replayed,
	});
}

function read(
	route: Route,
	store: WorldStore,
	principal: PublicationPrincipal | null,
	query: { limit: number; after: string | null },
	images?: ReadonlyMap<string, PublicLifeImage>,
): Response {
	const { worldId, action, target } = route;
	if (action === "settings") return reply(store.publicationSettings(worldId));
	if (action === "job") return reply(store.publicationJob(worldId, target));
	if (!principal) return failure(403);
	if (action === "feed")
		return reply(store.publicationFeed(worldId, principal, query, images));
	if (action === "cursor")
		return reply(store.publicationReadCursor(worldId, principal));
	const post = store.publicationPost(worldId, principal, target, images);
	return post ? reply(post) : failure(404);
}

function errorResponse(error: unknown): Response {
	if (error instanceof ModelRequestError && error.code === "not_configured")
		return reply(
			{
				error: "공통 모델 등급 설정을 확인해주세요.",
				code: "MODEL_NOT_CONFIGURED",
			},
			409,
		);
	// Core currently throws Error, not typed HTTP errors. Never serialize its message.
	const message = error instanceof Error ? error.message : "";
	if (
		/ownership|unauthorized|forbidden|revoked|foreign|authority|scope/i.test(
			message,
		)
	)
		return failure(403);
	if (
		/conflict|stale|changed|reconciliation|requires current eligible outcome|advance the publication run before retry/i.test(
			message,
		)
	)
		return failure(409);
	if (
		/^Unknown (?:publication (?:job|post|run|grant world)|world)\b|^Missing publication grant head or history$|^Publication (?:cursor post|interaction parent|reaction) unavailable$/.test(
			message,
		)
	)
		return failure(404);
	return failure(400);
}

/** Local owner management plus bearer-scoped reads; never activates fleet execution on reads. */
export async function lifePublicationRoutes(
	request: Request,
	services: PublicationRouteServices,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		// Bun can expose an invalid URL when a raw HTTP Host contains a bad port.
		return failure(403);
	}
	const parts = url.pathname.split("/");
	if (
		parts[1] !== "api" ||
		parts[2] !== "life" ||
		parts[3] !== "worlds" ||
		(parts[5] !== "publication" && parts[5] !== "feed")
	)
		return;
	let route: Route | undefined;
	try {
		route = matchRoute(parts);
	} catch {
		return failure(404);
	}
	if (
		!route ||
		request.url.length > MAX_URL_LENGTH ||
		/[%\\]/.test(url.pathname) ||
		request.url.includes("\\")
	)
		return failure(404);
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host ||
		url.username ||
		url.password
	)
		return failure(403);
	if (!METHODS[route.action].includes(request.method))
		return reply({ error: "Method not allowed" }, 405, {
			Allow: METHODS[route.action].join(", "),
		});
	const viewer = parts[5] === "feed",
		authorization = request.headers.get("authorization");
	if (viewer && (!authorization || !BEARER.test(authorization)))
		return failure(403);
	try {
		if (url.hash) return failure(400);
		const query = feedQuery(url, route.action);
		checkBodyHeaders(request);
		const body: unknown = request.method === "GET" ? null : await json();
		if (route.action === "run") {
			jsonBoundary(body);
			fields(body, [
				"requestKey",
				"expectedConfigRevision",
				"expectedSettingsRevision",
			]);
			const input: PublicationRunInput = {
				requestKey: identifier(body.requestKey),
				expectedConfigRevision: revision(body.expectedConfigRevision),
				expectedSettingsRevision: revision(body.expectedSettingsRevision),
				mode: "manual",
			};
			return reply(await services.run(route.worldId, input, request.signal));
		}
		const interact = interactionAction(route.action)
			? interactionMutation(route, body)
			: null;
		const write =
			request.method === "GET" || interact
				? null
				: mutation(route, body, () => services.changed?.(route.worldId));
		const store = services.store();
		const principal = viewer
			? viewerPrincipal(store, route.worldId, authorization)
			: null;
		if (viewer && !principal) return failure(403);
		if (viewer) currentSource(services, store, route.worldId);
		if (interact && principal)
			return interactionResponse(
				route,
				interact(store, principal),
				services,
				authorization,
			);
		return write
			? reply(write(store, principal))
			: read(
					route,
					store,
					principal,
					query,
					principal && (route.action === "feed" || route.action === "post")
						? services.images?.(
								route.worldId,
								principal,
								route.action === "feed"
									? store
											.publicationFeed(route.worldId, principal, query)
											.items.map((post) => post.id)
									: store.publicationPost(
												route.worldId,
												principal,
												route.target,
											)
										? [route.target]
										: [],
							)
						: undefined,
				);
	} catch (error) {
		return errorResponse(error);
	}
}
