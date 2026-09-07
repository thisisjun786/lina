import type { WorldContext } from "./types.ts";

/** Versioned handoff only; image providers and UI are owned by their consumers. */
export interface WorldImageBrief {
	version: 1;
	origin: "fictional";
	worldId: string;
	definitionVersion: number;
	eventId: string;
	worldRevision: number;
	/** Stable across retries of this one requested asset. */
	requestId: string;
	/** Every included fact/scene detail must be shareable with this audience. */
	audience: string[];
	/** Snapshot taken for the accepted revision, never a later live scene. */
	scene: NonNullable<WorldContext["scene"]>;
	summary: string;
	/** Caller-authorized references; the world engine cannot edit appearance. */
	appearanceReferences: Array<{
		agentId: string;
		profileRevision: number;
		referenceId: string;
	}>;
}

/** A consumer receipt cannot modify the source world event. */
export interface WorldImageReceipt {
	version: 1;
	requestId: string;
	worldId: string;
	eventId: string;
	status: "succeeded" | "failed" | "unknown";
	assetId: string | null;
}

/** Export candidates stay in fictional memory scope; not native user observations. */
export interface WorldExperienceReference {
	version: 1;
	origin: "fictional";
	worldId: string;
	agentId: string;
	eventId: string;
	factId: string;
	text: string;
}
