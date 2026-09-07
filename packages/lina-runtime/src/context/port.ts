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
	reflect?: (text: string, signal: AbortSignal) => Promise<string>;
	observe?: (text: string, signal: AbortSignal) => Promise<string>;
	reasonMemory?: (text: string, signal: AbortSignal) => Promise<string>;
	analyzeImage?: (
		input: ImageAnalysisRequest,
		signal: AbortSignal,
	) => Promise<ImageAnalysisResult | null>;
	prepare(event: CompactSourceEvent): PreparedContext;
}
