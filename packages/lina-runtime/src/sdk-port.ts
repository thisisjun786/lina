/** SDK-independent execution port. Native event payloads are decoded at the seam. */
import type { SessionContextExposure } from "./context-policy.ts";
import type { DevelopmentNoticeMarker } from "./development/notices.ts";
import type { ModelControl } from "./models/port.ts";
export type PromptAdmission = {
	readonly signal: AbortSignal;
	readonly disposition: (value: "started" | "queued" | "handled") => void;
	readonly rejected: () => void;
};

export interface SessionPort {
	readonly models?: ModelControl;
	readonly sessionId: string;
	readonly sessionFile: string;
	/** Trusted native exposure receipts, available on policy-aware adapters. */
	contextLineage?(): readonly SessionContextExposure[];
	history(): readonly unknown[];
	hasActiveRun(): boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string, admission: PromptAdmission): Promise<void>;
	abort(): Promise<void>;
	clearQueue(): void;
	compact(instructions?: string): Promise<unknown>;
	usage(): { tokens: number | null; contextWindow: number | null };
	appendNotice(
		marker: DevelopmentNoticeMarker,
		text: string,
	): Promise<string | null>;
	close(): Promise<void>;
}
