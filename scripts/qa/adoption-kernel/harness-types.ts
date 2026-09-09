import type {
	Adoption,
	Evidence,
	JsonValue,
	KernelTrace,
	Purpose,
	ToolReceipt,
} from "./types.ts";

export type RunMode = "baseline" | "kernel" | "ablation";
export type ChatMessage = { role: "system" | "user"; content: string };
export type TransportConfig = {
	baseUrl: string;
	model: string;
	apiKey: string;
	timeoutMs: number;
	maxOutputTokens: 4096;
	temperature: 0;
	fetch?: typeof fetch;
};
export type TransportResult =
	| {
			kind: "ok";
			content: string;
			model: string;
			usage: { prompt: number; completion: number };
			latencyMs: number;
			requestId?: string;
	  }
	| {
			kind: "transport-failure";
			reason: "timeout" | "http" | "network" | "decode";
			status?: number;
			detail: string;
			latencyMs: number;
	  };
export interface ModelTransport {
	complete(
		messages: ChatMessage[],
		signal?: AbortSignal,
	): Promise<TransportResult>;
}
export type ToolName = "lookup" | "calculate" | "submit" | "check";
export type ToolSpec = {
	name: ToolName;
	description: string;
	arguments: JsonValue;
};
export type TaskData = {
	required: string[];
	condition: string;
	methods: Record<string, { condition: string; omit: string }>;
};
export type EnvironmentData = {
	lookups: Record<string, JsonValue>;
	tasks: Record<string, TaskData>;
	unavailableKeys: string[];
	unknownTasks: string[];
};
export type SourceEvent =
	| { kind: "observe" | "correct"; evidence: Evidence }
	| { kind: "retract"; actor: string; id: string; revision: number };
export type StageTrigger =
	| "answered"
	| "adopted"
	| "deferred"
	| "noop"
	| "owner-unknown";
export type PublicStage = {
	purpose: Purpose;
	events: SourceEvent[];
	advanceOn: StageTrigger;
};
export type Prelude = { tool: ToolName; args: JsonValue };
export type PublicCase = {
	version: 1;
	episodeId: string;
	stages: PublicStage[];
	tools: ToolSpec[];
	environment: EnvironmentData;
	prelude: Prelude[];
};
export type ToolResultEvent = {
	effectId: string;
	tool: string;
	args: JsonValue;
	receipt: ToolReceipt;
};
export type RawItem = {
	seq: number;
	sourceId: string;
	owner: string;
	kind: "source" | "receipt" | "retraction";
	text: string;
	domain: Evidence["domain"];
	role: Evidence["participantRole"];
	ref: { id: string; revision: number };
};
export type ModeInput = {
	purpose: Purpose;
	raw: RawItem[];
	derived: Adoption[];
	tools: ToolSpec[];
	attempt: number;
};
export type OmissionMeta = { rawIds: string[]; derivedIds: string[] };
export type SerializedInput = {
	messages: ChatMessage[];
	omitted: OmissionMeta;
	rawIds: string[];
	adoptionIds: string[];
};
export type RequestTrace = {
	stage: number;
	input: SerializedInput;
	transport: TransportResult;
	proposal: unknown;
};
export type StepTrace = {
	stage: number;
	kernel: KernelTrace;
	requestIndex: number | null;
};
export type StageTrace = {
	stage: number;
	purpose: Purpose;
	trigger: StageTrigger;
	effectId?: string;
};
export type EpisodeTrace = {
	version: 1;
	episodeId: string;
	mode: RunMode;
	status: "complete" | "incomplete" | "limit";
	requests: RequestTrace[];
	steps: StepTrace[];
	effects: ToolResultEvent[];
	adoptions: Adoption[];
	delivered: {
		effectId: string;
		bytes: string;
		audience: Purpose["audience"];
		stage: number;
	}[];
	stages: StageTrace[];
	bridges: {
		evidenceId: string;
		effectId: string;
		owner: string;
		revision: number;
	}[];
	detail?: string;
};
