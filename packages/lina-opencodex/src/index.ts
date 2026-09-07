/**
 * OpenCodex Hub adapter for Lina.
 *
 * Public API for main-process composition:
 * - OpenCodexHub.status() matches HubManagement: configured, connected, guiUrl, error, modelCount
 * - refresh(signal?) loads GET /v1/models; GET /v1/catalog 404 does not fail the hub
 * - catalog() returns CatalogModel[] with provider=opencodex and exact hub ids
 * - createModelControl(settingsGetter, agentId?) is the standalone fleet ModelControl
 * - createContextServices(settingsGetter, agentId?, systemPrompt?) implements
 *   SummaryCall/observe/reflect/recall/vision; prepare is owned by the session engine
 * - isolatedHomeConnection() returns catalog bytes plus a Codex provider table and does not write files
 * - childEnvironment() supplies OPENCODEX_API_AUTH_TOKEN for an isolated Codex process and is excluded from status JSON
 *
 * Role and authoring calls POST /v1/responses (or /v1/chat/completions when that is the only
 * advertised API) with stream:true, store:false, and input as a list. Exact model ids, no fallback.
 */

export { discoverOpenCodexConfig, type OpenCodexDiscovery } from "./config.ts";
export { OpenCodexError } from "./errors.ts";
export {
	type IsolatedHomeConnection,
	OpenCodexHub,
	type OpenCodexHubOptions,
	type OpenCodexStatus,
} from "./hub.ts";
