import { readFileSync } from "node:fs";
import type { OpenVikingConfig, OpenVikingIdentity } from "./types.ts";
import { assertResourcesRoot } from "./uri.ts";

const ENV_KEYS = {
	baseUrl: "LINA_OPENVIKING_URL",
	apiKey: "LINA_OPENVIKING_API_KEY",
	tokenFile: "LINA_OPENVIKING_TOKEN_FILE",
	rootUri: "LINA_OPENVIKING_ROOT_URI",
} as const;

function present(
	env: Record<string, string | undefined>,
	key: string,
): string | undefined {
	const value = env[key];
	if (value === undefined || value === "") return undefined;
	return value;
}

function baseUrl(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0"))
		throw new Error("invalid openviking baseUrl");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("invalid openviking baseUrl");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("openviking baseUrl must be http or https");
	if (url.search || url.hash || url.username || url.password)
		throw new Error("openviking baseUrl must be a bare origin or path");
	return url.href.replace(/\/+$/, "");
}

function apiKey(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value))
		throw new Error("invalid openviking apiKey");
	return value;
}

function readTokenFile(path: string): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new Error("invalid openviking TOKEN_FILE");
	}
	const token = text.trim();
	if (!token || /[\r\n\0]/.test(token))
		throw new Error("invalid openviking TOKEN_FILE");
	return token;
}

export function validateOpenVikingConfig(value: unknown): OpenVikingConfig {
	if (typeof value !== "object" || value === null)
		throw new Error("invalid openviking config");
	const object = value as Record<string, unknown>;
	const allowed = new Set(["baseUrl", "apiKey", "rootUri"]);
	for (const key of Object.keys(object))
		if (!allowed.has(key)) throw new Error(`unknown openviking config ${key}`);
	if (typeof object["rootUri"] !== "string")
		throw new Error("invalid openviking rootUri");
	let rootUri: string;
	try {
		rootUri = assertResourcesRoot(object["rootUri"]);
	} catch {
		throw new Error("invalid openviking rootUri");
	}
	return {
		baseUrl: baseUrl(object["baseUrl"]),
		apiKey: apiKey(object["apiKey"]),
		rootUri,
	};
}

export function parseOpenVikingEnv(
	env: Record<string, string | undefined>,
): OpenVikingConfig | undefined {
	const url = present(env, ENV_KEYS.baseUrl);
	const key = present(env, ENV_KEYS.apiKey);
	const tokenFile = present(env, ENV_KEYS.tokenFile);
	const rootUri = present(env, ENV_KEYS.rootUri);
	if (
		url === undefined &&
		key === undefined &&
		tokenFile === undefined &&
		rootUri === undefined
	)
		return undefined;
	if (key !== undefined && tokenFile !== undefined)
		throw new Error("openviking API_KEY and TOKEN_FILE cannot both be set");
	if (
		url === undefined ||
		rootUri === undefined ||
		(key === undefined && tokenFile === undefined)
	)
		throw new Error("incomplete openviking config");
	return validateOpenVikingConfig({
		baseUrl: url,
		apiKey: key ?? readTokenFile(tokenFile as string),
		rootUri,
	});
}

export function publicIdentity(config: OpenVikingConfig): OpenVikingIdentity {
	return { baseUrl: config.baseUrl, rootUri: config.rootUri };
}
