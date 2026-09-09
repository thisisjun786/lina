export type Domain = "real" | "fiction";
export type Visibility = "private" | "public";
export type Ref = { id: string; revision: number };
export type Quality = {
	status: "unverified" | "pass" | "fail";
	verifier: string | null;
	detail: string;
};

export type Evidence = {
	id: string;
	revision: number;
	subject: string;
	domain: Domain;
	visibility: Visibility;
	text: string;
	active: boolean;
	sourceOwner: string;
	sourceId: string;
	parents: Ref[];
	participantRole: "performer" | "observer" | "recipient";
	quality: Quality;
};
export type Purpose = {
	id: string;
	revision: number;
	subject: string;
	text: string;
	audience: Visibility;
	successCriteria: string;
	active: boolean;
	policyVersion: number;
};
export type Adoption = {
	id: string;
	revision: number;
	subject: string;
	domain: Domain;
	visibility: Visibility;
	kind: "understanding" | "plan" | "intention";
	text: string;
	refs: Ref[];
	condition: string;
	status: "active" | "withdrawn";
	sourceDecisionId: string;
};
export type ToolReceipt = {
	effectId: string;
	status: "completed" | "failed" | "unknown";
	output: JsonValue;
	quality: Quality;
};
export type Frame = {
	purpose: Purpose;
	evidence: Evidence[];
	adoptions: Adoption[];
	receipts: ToolReceipt[];
	version: 1;
};
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type Proposal =
	| { kind: "answer"; purposeRevision: number; text: string }
	| {
			kind: "adopt";
			purposeRevision: number;
			adoptionKind: Adoption["kind"];
			text: string;
			refs: Ref[];
			condition: string;
	  }
	| { kind: "tool"; purposeRevision: number; tool: string; args: JsonValue }
	| {
			kind: "defer";
			purposeRevision: number;
			reason: string;
			condition: string;
	  }
	| { kind: "noop"; purposeRevision: number; reason: string };
export interface ModelPort {
	propose(frame: Frame): Promise<unknown>;
}
export interface ToolPort {
	/** Synchronous owner admission is the final local-process authorization fence. */
	admit(effectId: string, args: JsonValue, fence: string): void;
	result(effectId: string): Promise<ToolReceipt | null>;
	reconcile(effectId: string): Promise<ToolReceipt | null>;
}
export interface DeliveryPort {
	/** Synchronous owner admission is the final local-process authorization fence. */
	admit(
		effectId: string,
		bytes: string,
		audience: Visibility,
		fence: string,
	): void;
	reconcile(effectId: string): Promise<ToolReceipt | null>;
}
export type KernelTrace = {
	status:
		| "rejected"
		| "deferred"
		| "noop"
		| "answered"
		| "adopted"
		| "dispatched"
		| "unknown";
	decisionId: string;
	detail?: string;
};
