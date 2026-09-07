import type { AgentInput } from "../agents/types.ts";
import type { ChapterId, InterviewMode, UserAnswers } from "./types.ts";
import type { UserSkipped } from "./user-basics.ts";

export type DialogueKind = "user" | "persona";
export type DialogueStatus = "active" | "applying" | "choices" | "done";
export type DialogueTurnStatus = "pending" | "done" | "failed";

export interface DialogueData {
	profile: AgentInput;
	chapters: Record<ChapterId, string>;
	user: Partial<UserAnswers>;
	userSkipped?: UserSkipped;
	summary: string[];
	ready: boolean;
}

export interface Room {
	id: string;
	agentId: string;
	kind: DialogueKind;
	status: DialogueStatus;
	revision: number;
	mode: InterviewMode;
	draftId: string | null;
	data: DialogueData;
	createdAt: number;
	finalization: Record<string, unknown> | null;
}

export interface Turn {
	id: string;
	requestId: string;
	seq: number;
	text: string | null;
	reply: string | null;
	status: DialogueTurnStatus;
	attempts: number;
	error: string | null;
	summary: string[];
	createdAt: number;
	repliedAt: number | null;
}

export type DialogueRoom = Room;
export type DialogueTurn = Turn;

export type CreateDialogueInput = {
	agentId: string;
	kind: DialogueKind;
	mode: InterviewMode;
	draftId: string | null;
	data: DialogueData;
};

export type DialoguePatch = {
	mode?: InterviewMode;
	status?: DialogueStatus;
	finalization?: Record<string, unknown> | null;
};

export const MAX_NON_DONE_ROOMS = 16;
export const MAX_NON_OPENING_TURNS = 64;
export const MAX_TURN_TEXT = 4000;
export const MAX_TURN_REPLY = 3000;
export const MAX_TRANSCRIPT_BYTES = 500_000;
export const MAX_SUMMARY_ITEMS = 6;
export const MAX_SUMMARY_ITEM = 300;
export const MAX_DIALOGUE_ERROR = 300;
export const MAX_FINALIZATION_BYTES = 16_000;
