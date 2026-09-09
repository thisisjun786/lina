import type { SourceProof } from "../../../lina-core/src/source-policy.ts";
export type MemorySnapshot = {
	migrationRequired?: boolean;
	personaGrowth?: {
		error: "persona_processing_failed" | null;
		coverage?:
			| { selectedRecords: number; omittedRecords: number; inputChars: number }
			| undefined;
	};
	consolidation?: import("./memory-consolidation.ts").ConsolidationStatus;
	service: "disabled" | "ready" | "unavailable";
	pending: number;
	sending: number;
	accepted: number;
	unknown: number;
	failed: number;
	withheld: number;
	freshness: "unknown";
	recallText: string;
};

export interface MemoryPort {
	status(): MemorySnapshot;
	refresh(): Promise<void>;
	recall(query: string, signal?: AbortSignal): Promise<string>;
	recallSourceProofs(text: string): SourceProof[] | undefined;
	close(): Promise<void>;
}
/** No file or network owner. Legacy external stores require a separately selected migration. */
export class InactiveMemory implements MemoryPort {
	private closed = false;
	constructor(private reason: "disabled" | "migration_required" = "disabled") {}
	status(): MemorySnapshot {
		return {
			service:
				this.closed || this.reason === "disabled" ? "disabled" : "unavailable",
			migrationRequired: this.reason === "migration_required",
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			failed: 0,
			withheld: 0,
			freshness: "unknown",
			recallText: "",
		};
	}
	async refresh(): Promise<void> {}
	async recall(_query: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		return "";
	}
	recallSourceProofs(_text: string): SourceProof[] | undefined {
		return undefined;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}
