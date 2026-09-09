import type { IdentityPolicySnapshot, LifeReceipt } from "./life-types.ts";
import type {
	SocialExtensionIntent,
	SocialLimits,
	SocialResolution,
	SocialResolveInput,
	TargetResponse,
} from "./social-types.ts";

/** Trusted application preparation. Model arguments occupy only intent/targetResponse. */
export interface SocialPrepareRequestV1 {
	version: 1;
	worldId: string;
	requestId: string;
	intent: unknown;
	targetResponse: TargetResponse | null;
	identity: IdentityPolicySnapshot;
	simulationTime: number;
	limits: SocialLimits;
}
export type SocialPrepareRequestV2 = Omit<SocialPrepareRequestV1, "version"> & {
	version: 2;
	stepId: string;
};
export type SocialPrepareRequest =
	| SocialPrepareRequestV1
	| SocialPrepareRequestV2;
type ExtensionInput<T> = T extends SocialResolveInput
	? Omit<T, "intent" | "bootstrap"> & {
			kind: "extension";
			intent: SocialExtensionIntent;
			bootstrap: null;
		}
	: never;
export type SocialExtensionInput = ExtensionInput<SocialResolveInput>;
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
