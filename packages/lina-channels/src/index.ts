export { DiscordAdapter } from "./adapters/discord.ts";
export { TelegramAdapter } from "./adapters/telegram.ts";
export type {
	InterventionClient,
	InterventionClientOptions,
} from "./bridge/intervention-client.ts";
export { createInterventionClient } from "./bridge/intervention-client.ts";
export type { MainOptions } from "./bridge/wiring.ts";
export type {
	GatewaySource,
	GatewaySourceOptions,
} from "./discord/gateway-source.ts";
export {
	createGatewaySource,
	MISSING_CONTENT_LOG,
} from "./discord/gateway-source.ts";
export type {
	BridgeConfig,
	BridgeConfigResult,
	DiscordMessage,
} from "./discord/schemas.ts";
export { BridgeConfigSchema, parseBridgeConfig } from "./discord/schemas.ts";
export type { BridgeDependencies, BridgeRuntime } from "./discord-bridge.ts";
export {
	BridgeFatalError,
	main as runDiscordBridge,
	runBridge,
} from "./discord-bridge.ts";
export type { ChannelAdapter, SessionInjector } from "./reply-listener.ts";
export { startReplyListener } from "./reply-listener.ts";
export { RegistryLineError, SessionRegistry } from "./session-registry.ts";
export type {
	Channel,
	ChannelId,
	InboundMessage,
	MessageId,
	RegistryEntry,
	SessionId,
} from "./types.ts";
export {
	CHANNELS,
	InboundMessageSchema,
	NotImplementedError,
	RegistryEntrySchema,
} from "./types.ts";
