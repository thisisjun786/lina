import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type DesktopConfig = {
	readonly serverOrigin: string;
	readonly brokerPort: number;
	readonly userData: string;
	readonly sessionData: string;
	readonly externalOrigins: readonly string[];
};
const DEFAULT_BROKER_PORT = 43127;

function port(raw: string): number {
	if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535)
		throw Error("Desktop port must be an integer from 1 to 65535.");
	return Number(raw);
}

/** Reject DNS and noncanonical IP spellings before URL normalization. */
export function serverOrigin(raw: string): string {
	const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/.exec(raw);
	if (!match?.[2])
		throw Error(
			"LINA_DESKTOP_SERVER_URL must be http://127.0.0.1:PORT or http://[::1]:PORT.",
		);
	port(match[2]);
	return new URL(raw).origin;
}

function httpsUrl(raw: unknown): URL {
	if (typeof raw !== "string" || raw.length > 4096 || /[\s\\]/u.test(raw))
		throw Error("Invalid external link.");
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password)
		throw Error("Only HTTPS links without credentials are allowed.");
	return url;
}

export function externalUrl(raw: unknown, origins: readonly string[]): string {
	// Match the raw form: URL normalization must not turn traversal into a thread link.
	if (
		typeof raw === "string" &&
		/^codex:\/\/threads\/[a-zA-Z0-9_-]{1,128}$/.test(raw)
	)
		return raw;
	const url = httpsUrl(raw);
	if (!origins.includes(url.origin))
		throw Error("External site is not allowed.");
	return url.href;
}

export function desktopConfig(
	env: Record<string, string | undefined>,
): DesktopConfig {
	const upstream = env["LINA_DESKTOP_SERVER_URL"];
	if (!upstream)
		throw Error(
			"Set LINA_DESKTOP_SERVER_URL to your Lina web server's loopback HTTP origin.",
		);
	const origin = serverOrigin(upstream);
	const brokerPort = port(
		env["LINA_DESKTOP_PORT"] ?? String(DEFAULT_BROKER_PORT),
	);
	if (Number(new URL(origin).port || 80) === brokerPort)
		throw Error("Lina server and desktop broker must use different ports.");
	const userData =
		env["LINA_DESKTOP_USER_DATA"] ??
		join(env["LINA_HOME"] ?? join(homedir(), ".lina"), "desktop");
	if (!isAbsolute(userData))
		throw Error("Desktop data directory must be absolute.");
	const externalOrigins = (
		env["LINA_DESKTOP_EXTERNAL_ORIGINS"] ?? "https://github.com"
	)
		.split(",")
		.filter(Boolean)
		.map((value) => {
			const url = httpsUrl(value);
			if (
				url.pathname !== "/" ||
				url.search ||
				url.hash ||
				url.hostname === "localhost" ||
				/^[\d[]/.test(url.hostname)
			)
				throw Error(
					"External allowlist entries must be exact public HTTPS origins.",
				);
			return url.origin;
		});
	return {
		serverOrigin: origin,
		brokerPort,
		userData,
		sessionData: join(userData, "sessions"),
		externalOrigins,
	};
}
