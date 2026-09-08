import { bounded } from "./attachment-proxy.ts";
/** Private management API; target stays on the configured loopback controller. */
export async function proxyAgents(
	request: Request,
	upstream: string,
	allows: (host: string | null, origin: string | null) => boolean,
	headers: Record<string, string>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const intro =
		/^\/api\/(?:onboarding\/(?:entry|rooms\/[a-f0-9-]{36})|agents\/(?:birth|[a-z][a-z0-9-]{0,47}\/intro(?:\/(?:turn|finish|choose|mode|restart))?))$/.test(
			url.pathname,
		);
	const onboarding =
		/^\/api\/onboarding(?:\/(?:user|interview|preview|drafts(?:\/[a-f0-9-]{36}(?:\/(?:answer|apply))?)?))?$/.test(
			url.pathname,
		);
	if (
		!onboarding &&
		!intro &&
		!/^\/api\/(?:hub\/(?:status|refresh)|tasks(?:\/[a-zA-Z0-9_-]{1,128}(?:\/(?:messages|interrupt|owner|approval))?)?)$/.test(
			url.pathname,
		) &&
		!/^\/api\/(models(?:\/(?:settings|test))?|agents(?:\/[a-z][a-z0-9-]{0,47}(?:\/(?:mind(?:\/retract)?|avatar|revert|memory|conversation(?:\/preferences\/reset)?|visual(?:\/(?:references|history|pin|apply|restore)?)?))?)?|avatars\/[a-f0-9]{64})$/.test(
			url.pathname,
		)
	)
		return;
	const read = request.method === "GET";
	if (
		url.search ||
		(!read && !["POST", "PATCH", "PUT"].includes(request.method))
	)
		return new Response("Invalid request", { status: 400, headers });
	if (
		!allows(request.headers.get("host"), request.headers.get("origin")) &&
		!(read && request.headers.get("Sec-Fetch-Site") === "same-origin")
	)
		return new Response("Forbidden", { status: 403, headers });
	const limit =
		url.pathname.endsWith("/avatar") || url.pathname.endsWith("/references")
			? 2097152
			: 65536;
	const authoring =
		(onboarding && /\/(?:interview|preview)$/.test(url.pathname)) ||
		(intro && /(?:\/birth|\/intro\/(?:turn|choose))$/.test(url.pathname));
	const signal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(authoring ? 75000 : 15000),
	]);
	try {
		const length = Number(request.headers.get("content-length"));
		if (length > limit)
			return new Response("Too large", { status: 413, headers });
		const bytes = read ? undefined : await bounded(request.body, signal, limit);
		const target = new URL(upstream);
		target.protocol = "http:";
		target.pathname = url.pathname;
		target.search = "";
		const outgoing = new Headers({
			"Content-Type": request.headers.get("content-type") ?? "application/json",
		});
		for (const name of [
			"X-Lina-Filename",
			"X-Lina-Revision",
			"X-Lina-Profile-Revision",
			"X-Lina-Visual-Revision",
			"X-Lina-Request-Key",
		]) {
			const value = request.headers.get(name);
			if (value && value.length < 1024) outgoing.set(name, value);
		}
		const response = await fetch(target, {
			method: request.method,
			headers: outgoing,
			...(bytes ? { body: bytes } : {}),
			signal,
			redirect: "error",
		});
		const result = await bounded(response.body, signal, 2097152 + 65536);
		return new Response(result, {
			status: response.status,
			headers: {
				...headers,
				"Content-Type":
					response.headers.get("content-type") ?? "application/json",
			},
		});
	} catch {
		return new Response("Agent service unavailable", { status: 502, headers });
	}
}
