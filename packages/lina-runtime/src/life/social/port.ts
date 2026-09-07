import type {
	SocialResolution,
	SocialResolveInput,
} from "../../../../lina-core/src/world/social-types.ts";

/** Internal authoritative data only; receipts and acceptance belong to the service. */
export interface SocialEnginePort {
	resolve(
		input: SocialResolveInput,
		signal: AbortSignal,
	): Promise<SocialResolution>;
}
