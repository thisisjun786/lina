import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type {
	CatalogModel,
	ModelControl,
} from "../../lina-runtime/src/models/port.ts";
import {
	deriveNativeCatalog,
	type HubModel,
	mergeNativeCatalog,
	parseHubModels,
	publicCatalog,
	validateHubCatalog,
} from "./catalog.ts";
import {
	CATALOG_MAX_BYTES,
	DEFAULT_TIMEOUT_MS,
	type FetchLike,
	type HubRequest,
	hubJson,
	MODELS_MAX_BYTES,
} from "./client.ts";
import {
	type DiscoveryInput,
	discoverOpenCodexConfig,
	type OpenCodexDiscovery,
} from "./config.ts";
import { OpenCodexError } from "./errors.ts";
import {
	createOpenCodexContextServices,
	createOpenCodexModelControl,
	type SettingsGetter,
} from "./services.ts";

export type OpenCodexHubOptions = DiscoveryInput & {
	fetchImpl?: FetchLike;
};

export type OpenCodexStatus = {
	configured: boolean;
	connected: boolean;
	guiUrl: string | null;
	error: string | null;
	modelCount: number;
};

export type IsolatedHomeConnection = {
	origin: string;
	baseUrl: string;
	catalogJson: string | null;
	catalogSource: "hub" | "local-metadata" | "derived-models" | "missing";
	requiresAdmissionToken: boolean;
	tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
	providerTable: string;
};

function tomlString(value: string): string {
	return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function providerTable(
	baseUrl: string,
	requiresAdmissionToken: boolean,
): string {
	const lines = [
		"[model_providers.opencodex]",
		'name = "OpenCodex Proxy"',
		"base_url = " + tomlString(baseUrl),
		'wire_api = "responses"',
		"requires_openai_auth = false",
	];
	if (requiresAdmissionToken)
		lines.push('env_key = "OPENCODEX_API_AUTH_TOKEN"');
	return lines.join("\n") + "\n";
}

function localCatalogPath(
	env: NodeJS.ProcessEnv,
	homeDir: string | undefined,
): string {
	const home = env["CODEX_HOME"]?.trim();
	if (home) return join(home, "opencodex-catalog.json");
	return join(homeDir ?? homedir(), ".codex", "opencodex-catalog.json");
}

function readLocalCatalog(path: string): string | null {
	try {
		if (statSync(path).size > CATALOG_MAX_BYTES) return null;
		const body = readFileSync(path, "utf8");
		validateHubCatalog(JSON.parse(body) as unknown);
		return body;
	} catch {
		return null;
	}
}

export class OpenCodexHub {
	private discovery: OpenCodexDiscovery;
	private models: HubModel[] = [];
	private connected = false;
	private lastError: string | null;
	private hubCatalog: string | null = null;
	private readonly options: OpenCodexHubOptions;

	constructor(options: OpenCodexHubOptions = {}) {
		this.options = options;
		this.discovery = discoverOpenCodexConfig(options);
		this.lastError = this.discovery.error;
	}

	private runtime() {
		const runtime = {
			origin: () => {
				const origin = this.discovery.origin;
				if (!origin)
					throw new OpenCodexError(
						"not_configured",
						this.discovery.error ?? "OpenCodex Hub is not configured",
					);
				return origin;
			},
			token: () => this.discovery.admissionToken,
			models: () => this.models,
		};
		return this.options.fetchImpl
			? { ...runtime, fetchImpl: this.options.fetchImpl }
			: runtime;
	}

	status(): OpenCodexStatus {
		return {
			configured: this.discovery.configured,
			connected: this.connected,
			guiUrl: this.discovery.guiUrl,
			error: this.lastError,
			modelCount: this.models.length,
		};
	}

	catalog(): CatalogModel[] {
		return publicCatalog(this.models);
	}

	/** Child-process env for isolated Codex. Never copy this object into public JSON. */
	childEnvironment(): Record<string, string | undefined> {
		return {
			OPENCODEX_API_AUTH_TOKEN: this.discovery.admissionToken ?? undefined,
		};
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		this.discovery = discoverOpenCodexConfig(this.options);
		this.hubCatalog = null;
		if (!this.discovery.configured || !this.discovery.origin) {
			this.connected = false;
			this.models = [];
			this.lastError = this.discovery.error;
			return;
		}
		const origin = this.discovery.origin;
		const token = this.discovery.admissionToken;
		try {
			const modelsReq: HubRequest = {
				origin,
				path: "/v1/models",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxBytes: MODELS_MAX_BYTES,
			};
			if (token) modelsReq.token = token;
			if (signal) modelsReq.signal = signal;
			if (this.options.fetchImpl) modelsReq.fetchImpl = this.options.fetchImpl;
			const models = await hubJson(modelsReq);
			this.models = parseHubModels(models.json);
			this.connected = true;
			this.lastError = null;
		} catch (error) {
			this.connected = false;
			this.models = [];
			this.lastError =
				error instanceof OpenCodexError
					? error.message
					: "OpenCodex 모델 목록을 불러오지 못했습니다. 연결 상태를 확인해주세요.";
			throw error instanceof OpenCodexError
				? error
				: new OpenCodexError("unreachable", this.lastError);
		}
		try {
			const catalogReq: HubRequest = {
				origin,
				path: "/v1/catalog",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxBytes: CATALOG_MAX_BYTES,
			};
			if (token) catalogReq.token = token;
			if (signal) catalogReq.signal = signal;
			if (this.options.fetchImpl) catalogReq.fetchImpl = this.options.fetchImpl;
			const catalog = await hubJson(catalogReq);
			this.hubCatalog = validateHubCatalog(catalog.json);
		} catch (error) {
			if (error instanceof OpenCodexError && error.status === 404) {
				this.hubCatalog = null;
				return;
			}
			this.hubCatalog = null;
		}
	}

	createModelControl(
		settingsGetter: SettingsGetter,
		agentId?: string,
	): ModelControl {
		return createOpenCodexModelControl(this.runtime(), settingsGetter, agentId);
	}

	createContextServices(
		settingsGetter: SettingsGetter,
		agentId?: string,
		systemPrompt?: string,
	): ContextServices {
		return createOpenCodexContextServices(
			this.runtime(),
			settingsGetter,
			agentId,
			systemPrompt,
		);
	}

	isolatedHomeConnection(): IsolatedHomeConnection | null {
		const origin = this.discovery.origin;
		if (!origin || !this.discovery.configured) return null;
		const baseUrl = origin + "/v1";
		let catalogJson = this.hubCatalog;
		let catalogSource: IsolatedHomeConnection["catalogSource"] = catalogJson
			? "hub"
			: "missing";
		if (!catalogJson) {
			const local = readLocalCatalog(
				localCatalogPath(this.options.env ?? process.env, this.options.homeDir),
			);
			if (local) {
				catalogJson = local;
				catalogSource = "local-metadata";
			} else if (this.models.length) {
				catalogJson = deriveNativeCatalog(this.models);
				catalogSource = "derived-models";
			}
		}
		if (catalogJson && this.models.length)
			catalogJson = mergeNativeCatalog(catalogJson, this.models);
		return {
			origin,
			baseUrl,
			catalogJson,
			catalogSource,
			requiresAdmissionToken: this.discovery.tokenRequired,
			tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
			providerTable: providerTable(baseUrl, this.discovery.tokenRequired),
		};
	}
}
