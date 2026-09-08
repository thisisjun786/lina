import {
	fields,
	id,
	integer,
	text,
} from "../../lina-core/src/world/validation.ts";
import { bounded } from "./attachment-proxy.ts";

const REQUEST_LIMIT = 65_536;
const RESPONSE_LIMIT = 2_097_152;
const URL_LIMIT = 4096;
const AFTER_LIMIT = 2048;
const TIMEOUT_MS = 15_000;
const BEARER = /^Bearer llv1_[A-Za-z0-9_-]{43}$/;
type Route = "feed" | "post" | "cursor" | "replies" | "reactions" | "reshares";
const METHODS: Record<Route, readonly string[]> = {
	feed: ["GET"],
	post: ["GET"],
	cursor: ["GET", "PUT"],
	replies: ["POST"],
	reactions: ["PUT"],
	reshares: ["POST"],
};

function route(path: string): Route | undefined {
	const parts = path.split("/");
	if (parts[3] !== "worlds" || parts[5] !== "feed") return;
	try {
		id(parts[4]);
		if (parts.length === 6) return "feed";
		if (parts.length === 7 && parts[6] === "cursor") return "cursor";
		if (parts[6] !== "posts") return;
		id(parts[7]);
		if (parts.length === 8) return "post";
		const action = parts[8];
		if (
			parts.length === 9 &&
			(action === "replies" || action === "reactions" || action === "reshares")
		)
			return action;
	} catch {
		return;
	}
}

function validQuery(url: URL, action: Route): boolean {
	if (!url.search) return true;
	if (action !== "feed") return false;
	// Canonical ASCII query only: no encoded keys, separators or duplicate fields.
	if (
		!/^\?(?:after|limit)=[A-Za-z0-9._~-]+(?:&(?:after|limit)=[A-Za-z0-9._~-]+)?$/.test(
			url.search,
		)
	)
		return false;
	for (const [key, value] of url.searchParams) {
		if (url.searchParams.getAll(key).length !== 1) return false;
		if (key === "limit") {
			if (!/^(?:[1-9][0-9]?|100)$/.test(value)) return false;
		} else if (
			value.length > AFTER_LIMIT ||
			/llv1_[A-Za-z0-9_-]{43}/.test(value)
		) {
			return false;
		}
	}
	return true;
}

function validateBody(value: unknown, action: Route): void {
	if (action === "cursor") {
		fields(value, ["expectedRevision", "postId"]);
		integer(value.expectedRevision, "cursor revision");
		id(value.postId);
		return;
	}
	const extra: readonly ("text" | "reactionId" | "active")[] =
		action === "replies"
			? ["text"]
			: action === "reactions"
				? ["reactionId", "active"]
				: [];
	fields(value, ["requestKey", "expectedPostRevision", ...extra]);
	id(value.requestKey);
	integer(value.expectedPostRevision, "post revision");
	if (action === "replies") text(value.text, "reply");
	if (action === "reactions") {
		id(value.reactionId);
		if (typeof value.active !== "boolean") throw Error("Invalid reaction");
	}
}

function upstreamError(status: number): [number, string] {
	switch (status) {
		case 400:
			return [400, "Invalid request"];
		case 401:
		case 403:
			return [403, "Forbidden"];
		case 404:
			return [404, "Not found"];
		case 409:
			return [409, "Conflict"];
		case 413:
			return [413, "Too large"];
		case 429:
			return [429, "Too many requests"];
		default:
			return [502, "LIFE service unavailable"];
	}
}

/** Feed-only transport. Runtime resolves the bearer grant and current visibility. */
export async function proxyLife(
	request: Request,
	upstream: string,
	allows: (host: string | null, origin: string | null) => boolean,
	security: Record<string, string>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/life" && !url.pathname.startsWith("/api/life/"))
		return;
	const fail = (status: number, message: string) =>
		new Response(message, { status, headers: security });
	if (
		request.url.length > URL_LIMIT ||
		url.username ||
		url.password ||
		url.hash
	)
		return fail(400, "Invalid request");
	const action = route(url.pathname);
	if (!action) return fail(404, "Not found");
	const authorization = request.headers.get("authorization");
	const read = request.method === "GET";
	// Same-origin browser GET commonly omits Origin. This read still needs the scoped
	// bearer, Fetch Metadata and the existing actual-Host allowlist; writes require Origin.
	const origin =
		request.headers.get("origin") ??
		(read && request.headers.get("sec-fetch-site") === "same-origin"
			? url.origin
			: null);
	if (
		!authorization ||
		!BEARER.test(authorization) ||
		!allows(request.headers.get("host"), origin)
	)
		return fail(403, "Forbidden");
	if (!METHODS[action].includes(request.method))
		return fail(405, "Method not allowed");
	if (!validQuery(url, action) || request.headers.has("content-encoding"))
		return fail(400, "Invalid request");
	const length = request.headers.get("content-length");
	if (
		length !== null &&
		(!/^\d+$/.test(length) || Number(length) > REQUEST_LIMIT)
	)
		return fail(413, "Too large");
	if (
		read &&
		(request.body !== null || (length !== null && Number(length) !== 0))
	)
		return fail(400, "Invalid request");
	const signal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(TIMEOUT_MS),
	]);
	let body: string | undefined;
	if (!read) {
		if (
			request.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json"
		)
			return fail(400, "Invalid request");
		try {
			const bytes = await bounded(request.body, signal, REQUEST_LIMIT);
			const value: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
			validateBody(value, action);
			body = JSON.stringify(value);
		} catch (error) {
			return error instanceof RangeError
				? fail(413, "Too large")
				: fail(400, "Invalid request");
		}
	}
	try {
		// startWebServer validated this fixed loopback ws:// controller URL.
		const target = new URL(upstream);
		target.protocol = "http:";
		target.pathname = url.pathname;
		target.search = url.search;
		const headers = new Headers({
			Authorization: authorization,
			Accept: "application/json",
		});
		if (!read) headers.set("Content-Type", "application/json");
		const response = await fetch(target, {
			method: request.method,
			headers,
			...(body === undefined ? {} : { body }),
			signal,
			redirect: "manual",
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return fail(...upstreamError(response.status));
		}
		if (response.status === 204 || response.status === 205)
			return new Response(null, { status: response.status, headers: security });
		if (
			response.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json"
		) {
			void response.body?.cancel().catch(() => {});
			return fail(502, "LIFE service unavailable");
		}
		const bytes = await bounded(response.body, signal, RESPONSE_LIMIT);
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return new Response(bytes, {
			status: response.status,
			headers: { ...security, "Content-Type": "application/json" },
		});
	} catch {
		return fail(502, "LIFE service unavailable");
	}
}
