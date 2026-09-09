import type {
	ModelProfile,
	ModelRole,
	ModelRouteRequest,
	ModelTier,
} from "../models/types.ts";
import type { ContextEstimator } from "./budget.ts";
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
	deriveResourceMemory?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
		maxInputTokens?: number,
	) => Promise<string>;
	memoryInputOverhead?: () => number;
	estimator?: ContextEstimator;
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
	/** Request output budget for roleCall; not a returned-string slice. */
	consolidate?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
	) => Promise<string>;
	/** Strict typed personal behavior interpretation, separate from memory claims. */
	interpretPersona?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
	) => Promise<string>;
	/** Resource callbacks reuse summary (summary) and recall (plan/rank). Host parses. */
	summarizeResource?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
		maxInputTokens?: number,
	) => Promise<string>;
	planResources?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
		maxInputTokens?: number,
	) => Promise<string>;
	rankResources?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		routeRequest?: ModelRouteRequest,
		maxTokens?: number,
		maxInputTokens?: number,
	) => Promise<string>;
	resourceInputOverhead?: (kind: "summary" | "plan" | "rank") => number;
	analyzeImage?: (
		input: ImageAnalysisRequest,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		maxTokens?: number,
	) => Promise<ImageAnalysisResult | null>;
	prepare(event: CompactSourceEvent): PreparedContext;
}
