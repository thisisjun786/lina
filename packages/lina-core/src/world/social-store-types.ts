import type { IdentityPolicySnapshot, LifeReceipt } from "./life-types.ts";
import type {
	SocialExtensionIntent,
	SocialLimits,
	SocialResolution,
	SocialResolveInput,
	TargetResponse,
} from "./social-types.ts";

/** Trusted application preparation. Model arguments occupy only intent/targetResponse. */
export interface SocialPrepareRequest {
	version: 1;
	worldId: string;
	requestId: string;
	intent: unknown;
	targetResponse: TargetResponse | null;
	identity: IdentityPolicySnapshot;
	simulationTime: number;
	limits: SocialLimits;
}
export type SocialExtensionInput = Omit<
	SocialResolveInput,
	"intent" | "bootstrap"
> & {
	kind: "extension";
	intent: SocialExtensionIntent;
	bootstrap: null;
};
export interface SocialPreparedResolution {
	version: 1;
	worldId: string;
	requestId: string;
	requestDigest: string;
	inputDigest: string;
	input: SocialResolveInput | SocialExtensionInput;
	result: SocialResolution | null;
	acceptedLifeRevision: number | null;
}
export interface WorldSocialPort {
	prepareSocialResolution(
		request: SocialPrepareRequest,
		entropy: () => number,
	): SocialPreparedResolution;
	socialResolution(
		worldId: string,
		requestId: string,
	): SocialPreparedResolution;
	finishSocialResolution(
		worldId: string,
		requestId: string,
		result: SocialResolution,
	): SocialPreparedResolution;
	acceptSocialResolution(
		worldId: string,
		requestId: string,
		identity: IdentityPolicySnapshot,
	): LifeReceipt;
}
