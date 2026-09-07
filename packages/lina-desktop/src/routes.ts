const AGENT = "[a-z][a-z0-9-]{0,47}";
const UUID =
	"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const TASK = "[a-zA-Z0-9_-]{1,128}";
// Transport allowlist mirrors Lina web management paths. Domain validation stays on Lina.
const ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
	[/^\/api\/agents$/, ["GET", "POST"]],
	[new RegExp(`^/api/agents/${AGENT}$`), ["GET", "PATCH"]],
	[new RegExp(`^/api/agents/${AGENT}/mind$`), ["GET"]],
	[new RegExp(`^/api/agents/${AGENT}/conversation$`), ["GET", "PATCH"]],
	[
		new RegExp(
			`^/api/agents/${AGENT}/(?:avatar|revert|memory|mind/retract|conversation/preferences/reset)$`,
		),
		["POST"],
	],
	[/^\/api\/avatars\/[a-f0-9]{64}$/, ["GET"]],
	[/^\/api\/models$/, ["GET"]],
	[/^\/api\/models\/settings$/, ["PATCH"]],
	[/^\/api\/models\/test$/, ["POST"]],
	[/^\/api\/hub\/status$/, ["GET"]],
	[/^\/api\/hub\/refresh$/, ["POST"]],
	[/^\/api\/tasks$/, ["GET", "POST"]],
	[new RegExp(`^/api/tasks/${TASK}$`), ["GET"]],
	[
		new RegExp(`^/api/tasks/${TASK}/(?:messages|interrupt|owner|approval)$`),
		["POST"],
	],
	[/^\/api\/onboarding(?:\/entry)?$/, ["GET"]],
	[/^\/api\/onboarding\/user$/, ["PATCH"]],
	[/^\/api\/onboarding\/(?:drafts|interview|preview)$/, ["POST"]],
	[new RegExp(`^/api/onboarding/drafts/${UUID}$`), ["PATCH"]],
	[new RegExp(`^/api/onboarding/drafts/${UUID}/(?:answer|apply)$`), ["POST"]],
	[new RegExp(`^/api/onboarding/rooms/${UUID}$`), ["GET"]],
	[/^\/api\/agents\/birth$/, ["POST"]],
	[new RegExp(`^/api/agents/${AGENT}/intro$`), ["GET", "POST"]],
	[
		new RegExp(
			`^/api/agents/${AGENT}/intro/(?:turn|finish|choose|mode|restart)$`,
		),
		["POST"],
	],
];
const FILE = new RegExp(`^/api/attachments/${UUID}(?:/preview|/meta)?$`);

export function requestUrl(
	raw: string | undefined,
	origin: string,
): URL | undefined {
	if (
		!raw ||
		raw.length > 8192 ||
		!raw.startsWith("/") ||
		raw.startsWith("//") ||
		/[\\\s#]/u.test(raw)
	)
		return;
	const path = raw.split("?")[0] ?? "";
	if (
		path.includes("%") ||
		path.split("/").some((part) => part === "." || part === "..")
	)
		return;
	const url = new URL(raw, origin);
	return url.origin === origin ? url : undefined;
}

/** undefined = unknown route, otherwise HTTP rejection status or 0 (allowed). */
export function apiStatus(url: URL, method: string): number | undefined {
	if (url.pathname === "/api/attachments")
		return url.search ? 400 : method === "POST" ? 0 : 405;
	if (FILE.test(url.pathname)) {
		if (method !== "GET") return 405;
		return url.searchParams.size === 1 &&
			new RegExp(`^${UUID}$`).test(url.searchParams.get("sessionId") ?? "")
			? 0
			: 400;
	}
	const matches = ROUTES.filter(([pattern]) => pattern.test(url.pathname));
	if (!matches.length) return;
	if (url.search) return 400;
	return matches.some(([, methods]) => methods.includes(method)) ? 0 : 405;
}

export function socketPath(url: URL): boolean {
	return (
		url.pathname === "/ws" &&
		(url.searchParams.size === 0 ||
			(url.searchParams.size === 1 &&
				new RegExp(`^${AGENT}$`).test(url.searchParams.get("agent") ?? "")))
	);
}
