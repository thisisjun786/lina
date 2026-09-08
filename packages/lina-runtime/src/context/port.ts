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

export interface ContextServices {
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
	) => Promise<string>;
	observe?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
	) => Promise<string>;
	reasonMemory?: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
	) => Promise<string>;
	analyzeImage?: (
		input: ImageAnalysisRequest,
		signal: AbortSignal,
	) => Promise<ImageAnalysisResult | null>;
	prepare(event: CompactSourceEvent): PreparedContext;
}
