import type { BotBinding } from "../../../lina-core/src/protocol.ts";

export type { BotBinding };

// Operator-configured self-host coordinates. apiKey never leaves the process.
export interface HonchoConfig {
	baseUrl: string;
	workspaceId: string;
	sessionId: string;
	userPeerId: string;
	observerPeerId: string;
	apiKey?: string;
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
	| "failed";

export interface OutboxCounts {
	pending: number;
	sending: number;
	accepted: number;
	unknown: number;
	failed: number;
}

export interface ScanState {
	after: number;
	eligibleUser: boolean;
}

// The exact application match key stored as metadata.lina on every remote message.
export interface PartKey {
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
