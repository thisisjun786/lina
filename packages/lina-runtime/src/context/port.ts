import type {
	ModelProfile,
	ModelRole,
	ModelRouteRequest,
	ModelTier,
} from "../models/types.ts";
import type { CompactSourceEvent, PreparedContext } from "./native.ts";
import type { SummaryCall } from "./summarize.ts";

export type ImageAnalysisRequest = {
	bytes: Uint8Array;
	mimeType: string;
	question?: string;
};

export type ImageAnalysisResult = {
	provider: string;
	model: string;
	text: string;
};

export interface ContextRouteInfo {
	mode: "legacy" | "tier" | "override";
	settingsRevision: number;
	tier?: ModelTier;
	profileId: string;
	provider: string;
	model: string;
	requested: Pick<ModelProfile, "reasoning" | "maxOutputTokens">;
	applied: Pick<ModelProfile, "reasoning" | "maxOutputTokens">;
	reasoningStatus: "model_no_reasoning" | "omitted" | "verified" | "unverified";
}

export interface ContextServices {
	routeInfo?: (
		role: ModelRole,
		request?: ModelRouteRequest,
		maxTokens?: number,
	) => ContextRouteInfo;
	estimateText(text: string): number;
	estimateMessages(messages: readonly unknown[]): number;
	systemTokens: number;
	contextWindow: number;
	reserveTokens: number;
	summarize: SummaryCall;
	summaryCacheKey?: () => string;
	/** Optional callbacks are trusted synchronous checks, never payload metadata. */
	reflect?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
	) => Promise<string>;
	observe?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
	) => Promise<string>;
	reasonMemory?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
	) => Promise<string>;
	analyzeImage?: (
		input: ImageAnalysisRequest,
		signal: AbortSignal,
	) => Promise<ImageAnalysisResult | null>;
	prepare(event: CompactSourceEvent): PreparedContext;
}
