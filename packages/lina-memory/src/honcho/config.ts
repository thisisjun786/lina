import type { HonchoConfig, HonchoIdentity } from "./types.ts";

// Honcho a026beb RESOURCE_NAME_PATTERN for workspace/peer/session names.
const RESOURCE_NAME = /^[a-zA-Z0-9_-]{1,512}$/;
const MANAGED_HOSTS = new Set([
	"api.honcho.dev",
	"honcho.dev",
	"app.honcho.dev",
]);
const ENV_KEYS = {
	baseUrl: "LINA_HONCHO_BASE_URL",
	workspaceId: "LINA_HONCHO_WORKSPACE_ID",
	sessionId: "LINA_HONCHO_SESSION_ID",
	userPeerId: "LINA_HONCHO_USER_PEER_ID",
	observerPeerId: "LINA_HONCHO_OBSERVER_PEER_ID",
	apiKey: "LINA_HONCHO_API_KEY",
} as const;

function name(object: Record<string, unknown>, key: string): string {
	const value = object[key];
	if (typeof value !== "string" || !RESOURCE_NAME.test(value))
		throw new Error(`invalid honcho ${key}`);
	return value;
}

function baseUrl(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0"))
		throw new Error("invalid honcho baseUrl");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("invalid honcho baseUrl");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("honcho baseUrl must be http or https");
	if (url.search || url.hash || url.username || url.password)
		throw new Error("honcho baseUrl must be a bare origin or path");
	if (MANAGED_HOSTS.has(url.hostname.toLowerCase()))
		throw new Error(
			"managed Honcho hosts are not supported; configure a self-host",
		);
	return url.href.replace(/\/+$/, "");
}

export function validateHonchoConfig(value: unknown): HonchoConfig {
	if (typeof value !== "object" || value === null)
		throw new Error("invalid honcho config");
	const object = value as Record<string, unknown>;
	const allowed = new Set(Object.keys(ENV_KEYS));
	for (const key of Object.keys(object))
		if (!allowed.has(key)) throw new Error(`unknown honcho config ${key}`);
	const config: HonchoConfig = {
		baseUrl: baseUrl(object["baseUrl"]),
		workspaceId: name(object, "workspaceId"),
		sessionId: name(object, "sessionId"),
		userPeerId: name(object, "userPeerId"),
		observerPeerId: name(object, "observerPeerId"),
	};
	if (config.userPeerId === config.observerPeerId)
		throw new Error("honcho user and observer peers must differ");
	if (object["apiKey"] !== undefined) {
		const apiKey = object["apiKey"];
		if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n\0]/.test(apiKey))
			throw new Error("invalid honcho apiKey");
		config.apiKey = apiKey;
	}
	return config;
}

// All LINA_HONCHO_* unset means memory is disabled; a partial set is an error.
export function parseHonchoEnv(
	env: Record<string, string | undefined>,
): HonchoConfig | undefined {
	const present = Object.entries(ENV_KEYS).filter(
		([, envKey]) => env[envKey] !== undefined && env[envKey] !== "",
	);
	if (present.length === 0) return undefined;
	const raw: Record<string, unknown> = {};
	for (const [field, envKey] of present) raw[field] = env[envKey];
	return validateHonchoConfig(raw);
}

export function publicIdentity(config: HonchoConfig): HonchoIdentity {
	return {
		baseUrl: config.baseUrl,
		workspaceId: config.workspaceId,
		sessionId: config.sessionId,
		userPeerId: config.userPeerId,
		observerPeerId: config.observerPeerId,
	};
}
