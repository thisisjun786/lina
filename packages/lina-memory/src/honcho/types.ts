import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import type { SourceProof } from "../../../lina-core/src/source-policy.ts";

export type { BotBinding };

// Operator-configured self-host coordinates. apiKey never leaves the process.
export interface HonchoConfig {
	baseUrl: string;
	workspaceId: string;
	sessionId: string;
	userPeerId: string;
	observerPeerId: string;
	apiKey?: string;
	ordinaryNamespace?: OrdinaryNamespace;
}

export interface HonchoIdentity {
	baseUrl: string;
	workspaceId: string;
	sessionId: string;
	userPeerId: string;
	observerPeerId: string;
}

export type OutboxRole = "user" | "assistant";
export type OutboxState =
	| "pending"
	| "sending"
	| "accepted"
	| "unknown"
	| "failed"
	| "withheld";

export interface OutboxCounts {
	pending: number;
	sending: number;
	accepted: number;
	unknown: number;
	failed: number;
	withheld: number;
}

export interface ScanState {
	after: number;
	eligibleUser: boolean;
}

// The exact application match key stored as metadata.lina on every remote message.
export interface PartKey {
	version?: 2;
	sourceProofs?: SourceProof[];
	policyScope?: OrdinaryNamespace;
	entryId: string;
	partIndex: number;
	contentHash: string;
}

export interface OutboxPart extends PartKey {
	id: number;
	role: OutboxRole;
	content: string;
	state: OutboxState;
	remoteId?: string;
	error?: string;
	withheldReason?: string;
}

export interface RemoteMessage {
	id: string;
	workspaceId: string;
	sessionId: string;
	peerId: string;
	content: string;
	key: PartKey;
}

export interface RecallResult {
	proof?: RecallProof;
	text: string;
	scope: HonchoIdentity;
	freshness: "unknown";
}

export type MemoryService = "disabled" | "ready" | "unavailable";

export interface CaptureStatus {
	service: MemoryService;
	counts: OutboxCounts;
	freshness: "unknown";
}

export class HonchoRequestError extends Error {
	constructor(
		message: string,
		readonly kind: "network" | "timeout" | "redirect" | "status" | "body",
		readonly status?: number,
	) {
		super(message);
		this.name = "HonchoRequestError";
	}
}

// Operator selection is a destination, not evidence that an adapter enforces it.
export interface OrdinaryNamespace {
	version: 1;
	ownerBotId: string;
	generationId: string;
	workspaceId: string;
	sessionId: string;
	userPeerId: string;
	observerPeerId: string;
	sourcePolicyVersion: 1;
	qualificationId: string;
}
export interface GenerationOwner {
	binding: BotBinding;
	identity: HonchoIdentity;
	ordinaryNamespace: OrdinaryNamespace;
}
export interface NamespaceProof {
	version: 1;
	owner: GenerationOwner;
	isolation: "workspace";
	ordinaryOnly: true;
}
export interface RecallProof extends NamespaceProof {
	sourceProofs: SourceProof[];
}
// Explicit trusted adapter capability. The stock HTTP/v3 adapter has none.
// Implementations must verify a remote ordinary-only namespace and complete
// derivation provenance; echoing this request is not qualification.
export interface QualifiedHonchoAdapter {
	qualify(owner: GenerationOwner, signal?: AbortSignal): Promise<unknown>;
	recall(
		request: { owner: GenerationOwner; query: string; topK: number },
		signal?: AbortSignal,
	): Promise<unknown>;
}
