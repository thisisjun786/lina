import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCodexError } from "./errors.ts";

const CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const TOKEN_MAX_BYTES = 4096;

export type OpenCodexDiscovery = {
	configured: boolean;
	origin: string | null;
	guiUrl: string | null;
	tokenRequired: boolean;
	loopback: boolean;
	error: string | null;
	admissionToken: string | null;
};

export type DiscoveryInput = {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
};

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key];
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readBoundedFile(path: string, maxBytes: number): string | null {
	try {
		if (statSync(path).size > maxBytes) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "[::1]"
	);
}

export function normalizeOrigin(input: string): string {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new OpenCodexError(
			"url_invalid",
			"OpenCodex URL must be an absolute HTTP(S) URL",
		);
	}
	const path = parsed.pathname;
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		(path !== "/" && path !== "/v1" && path !== "/v1/" && path !== "")
	) {
		throw new OpenCodexError(
			"url_invalid",
			"OpenCodex URL must be an HTTP(S) origin without credentials, query, fragment, or extra path",
		);
	}
	return parsed.origin;
}

function originFromEnvOrConfig(raw: string): string | null {
	try {
		return normalizeOrigin(raw);
	} catch {
		return null;
	}
}

function readToken(env: NodeJS.ProcessEnv): string | null {
	const direct = envValue(env, "LINA_OPENCODEX_API_KEY");
	if (direct) {
		if (direct.length > TOKEN_MAX_BYTES || /[\r\n\0]/.test(direct))
			throw new OpenCodexError(
				"credential_invalid",
				"OpenCodex API key is invalid",
			);
		return direct;
	}
	const file = envValue(env, "LINA_OPENCODEX_TOKEN_FILE");
	if (!file) return null;
	const body = readBoundedFile(file, TOKEN_MAX_BYTES);
	if (body === null)
		throw new OpenCodexError(
			"credential_invalid",
			"OpenCodex token file is missing or too large",
		);
	const token = body.trim();
	if (!token || /[\r\n\0]/.test(token) || token.length > TOKEN_MAX_BYTES)
		throw new OpenCodexError(
			"credential_invalid",
			"OpenCodex token file is invalid",
		);
	return token;
}

function pickGui(raw: unknown): string | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const hub = (raw as { hub?: unknown }).hub;
	if (!hub || typeof hub !== "object" || Array.isArray(hub)) return null;
	const origin = (hub as { managementPublicOrigin?: unknown })
		.managementPublicOrigin;
	return typeof origin === "string" ? originFromEnvOrConfig(origin) : null;
}

function pickLoopback(raw: unknown): number | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const listener = (raw as { unauthenticatedLoopbackListener?: unknown })
		.unauthenticatedLoopbackListener;
	if (!listener || typeof listener !== "object" || Array.isArray(listener))
		return null;
	const enabled = (listener as { enabled?: unknown }).enabled;
	const port = (listener as { port?: unknown }).port;
	if (enabled !== true || typeof port !== "number" || !Number.isInteger(port))
		return null;
	if (port < 1 || port > 65535) return null;
	return port;
}

function hideToken(
	result: OpenCodexDiscovery,
	token: string | null,
): OpenCodexDiscovery {
	Object.defineProperty(result, "admissionToken", {
		value: token,
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return result;
}

export function discoverOpenCodexConfig(
	input: DiscoveryInput = {},
): OpenCodexDiscovery {
	const env = input.env ?? process.env;
	const home = input.homeDir ?? homedir();
	const configDir = envValue(env, "OPENCODEX_HOME") ?? join(home, ".opencodex");
	let parsed: unknown = null;
	const raw = readBoundedFile(join(configDir, "config.json"), CONFIG_MAX_BYTES);
	if (raw) {
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return hideToken(
				{
					configured: false,
					origin: null,
					guiUrl: null,
					tokenRequired: false,
					loopback: false,
					error: "OpenCodex config.json is invalid",
					admissionToken: null,
				},
				null,
			);
		}
	}
	let token: string | null = null;
	try {
		token = readToken(env);
	} catch (error) {
		const message =
			error instanceof OpenCodexError
				? error.message
				: "OpenCodex token is invalid";
		return hideToken(
			{
				configured: false,
				origin: null,
				guiUrl:
					originFromEnvOrConfig(
						envValue(env, "LINA_OPENCODEX_GUI_URL") ?? "",
					) ?? pickGui(parsed),
				tokenRequired: true,
				loopback: false,
				error: message,
				admissionToken: null,
			},
			null,
		);
	}
	const envOrigin = envValue(env, "LINA_OPENCODEX_BASE_URL");
	let origin: string | null = null;
	let originError: string | null = null;
	if (envOrigin) {
		try {
			origin = normalizeOrigin(envOrigin);
		} catch {
			originError = "LINA_OPENCODEX_BASE_URL is not a valid HTTP(S) origin";
		}
	} else {
		const port = pickLoopback(parsed);
		if (port !== null) origin = "http://127.0.0.1:" + String(port);
	}
	const envGui = envValue(env, "LINA_OPENCODEX_GUI_URL");
	const guiUrl = envGui ? originFromEnvOrConfig(envGui) : pickGui(parsed);
	const loopback = origin ? isLoopbackHost(new URL(origin).hostname) : false;
	const tokenRequired = Boolean(origin) && !loopback;
	if (originError) {
		return hideToken(
			{
				configured: false,
				origin: null,
				guiUrl,
				tokenRequired: false,
				loopback: false,
				error: originError,
				admissionToken: null,
			},
			token,
		);
	}
	if (!origin) {
		return hideToken(
			{
				configured: false,
				origin: null,
				guiUrl,
				tokenRequired: false,
				loopback: false,
				error: "OpenCodex Hub is not configured",
				admissionToken: token,
			},
			token,
		);
	}
	if (tokenRequired && !token) {
		return hideToken(
			{
				configured: false,
				origin,
				guiUrl,
				tokenRequired: true,
				loopback: false,
				error:
					"Remote OpenCodex Hub requires LINA_OPENCODEX_API_KEY or LINA_OPENCODEX_TOKEN_FILE",
				admissionToken: null,
			},
			null,
		);
	}
	return hideToken(
		{
			configured: true,
			origin,
			guiUrl,
			tokenRequired,
			loopback,
			error: null,
			admissionToken: null,
		},
		token,
	);
}
