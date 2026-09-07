export type EvolutionMode = "adaptive" | "manual";

export interface AgentProfile {
	id: string;
	name: string;
	role: string;
	personality: string;
	voice: string;
	profile: string;
	appearance: string;
	interests: string[];
	avatarId: string | null;
	evolution: EvolutionMode;
	revision: number;
}

export type AgentInput = Omit<AgentProfile, "revision">;

export interface Dynamics {
	revision: number;
	mood: { label: string; reason: string; expiresAt: number } | null;
	interests: string[];
	preferences: string[];
	relationship: string[];
	lastRequestId: string | null;
}

export interface ReflectionInput {
	profileRevision: number;
	dynamicsRevision: number;
	requestId: string;
	sourceEntryIds: string[];
	mood?: { label: string; reason: string };
	interests?: string[];
	preferences?: string[];
	relationship?: string[];
}

export interface AgentChange {
	id: number;
	kind: "edit" | "reflection" | "revert";
	createdAt: string;
	sourceEntryIds: string[];
	summary: string;
}
