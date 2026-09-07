import { apiStatus, socketPath } from "./routes.ts";

function localUrl(raw: string, origin: string): URL | undefined {
	try {
		const url = new URL(raw);
		return url.origin === origin && !url.username && !url.password
			? url
			: undefined;
	} catch {
		return;
	}
}
export function windowUrl(raw: string, origin: string): boolean {
	return localUrl(raw, origin)?.pathname === "/";
}
export function rendererRequest(raw: string, origin: string): boolean {
	if (localUrl(raw, origin)) return true;
	try {
		const url = new URL(raw);
		return (
			url.protocol === "ws:" &&
			!url.username &&
			!url.password &&
			url.host === new URL(origin).host &&
			socketPath(url)
		);
	} catch {
		return false;
	}
}
export function downloadUrl(raw: string, origin: string): boolean {
	const url = localUrl(raw, origin);
	return (
		!!url &&
		url.pathname.startsWith("/api/attachments/") &&
		apiStatus(url, "GET") === 0
	);
}
export function notificationInput(raw: unknown): {
	title: string;
	body: string;
} {
	if (
		!raw ||
		typeof raw !== "object" ||
		Object.keys(raw).some((key) => key !== "title" && key !== "body") ||
		!("title" in raw) ||
		!("body" in raw) ||
		typeof raw.title !== "string" ||
		typeof raw.body !== "string" ||
		!raw.title.trim() ||
		raw.title.length > 100 ||
		raw.body.length > 500
	)
		throw Error("Invalid notification");
	return { title: raw.title, body: raw.body };
}
