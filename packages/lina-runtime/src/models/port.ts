import type { ModelProfile, ModelRole } from "./types.ts";

export interface CatalogModel {
	supportedRoles?: ModelRole[];
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
	authenticated: boolean;
	/** Projected from native model input capabilities; absent means not supported. */
	imageInput?: boolean;
}
export interface ModelTrial {
	provider: string;
	model: string;
	text: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
}
export interface ModelControl {
	authoring?(
		input: {
			agentId: string;
			systemPrompt: string;
			messages: Array<{ role: "user" | "assistant"; content: string }>;
		},
		signal: AbortSignal,
	): Promise<{ provider: string; model: string; text: string }>;
	catalog(): CatalogModel[];
	test(
		profile: ModelProfile,
		prompt: string,
		signal: AbortSignal,
	): Promise<ModelTrial>;
	state(): {
		provider: string;
		model: string;
		settingsRevision: number;
		error: string | null;
	};
}
