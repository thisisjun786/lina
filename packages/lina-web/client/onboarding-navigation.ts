import { introRequest } from "./intro-api.ts";
import { parseChooseResult, parseSnapshot } from "./intro-model.ts";

let busy = false;
export async function createTemplateAgent(templateId: string): Promise<void> {
	if (busy) return;
	busy = true;
	const key = `lina.intro.templateBirth.${templateId}`;
	try {
		let birthId = localStorage.getItem(key);
		if (!birthId) {
			birthId = crypto.randomUUID();
			localStorage.setItem(key, birthId);
		}
		const result = parseChooseResult(
			await introRequest("/api/agents/birth", "POST", {
				birthId,
				templateId,
				mode: "thoughtful",
			}),
		);
		localStorage.removeItem(key);
		location.assign(result.url);
	} finally {
		busy = false;
	}
}

export async function createChatAgent(draftId?: string): Promise<void> {
	if (busy) return;
	busy = true;
	const key = `lina.intro.directBirth.${draftId ?? "new"}`;
	try {
		let birthId = localStorage.getItem(key);
		if (!birthId) {
			birthId = crypto.randomUUID();
			localStorage.setItem(key, birthId);
		}
		const result = parseChooseResult(
			await introRequest("/api/agents/birth", "POST", {
				birthId,
				presetId: null,
				mode: "thoughtful",
				...(draftId ? { draftId } : {}),
			}),
		);
		localStorage.removeItem(key);
		location.assign(result.url);
	} finally {
		busy = false;
	}
}
export async function refineChatAgent(agentId: string): Promise<void> {
	const state = parseSnapshot(
		await introRequest(`/api/agents/${agentId}/intro`, "POST", {
			kind: "persona",
			mode: "thoughtful",
		}),
	);
	if (!state.room) throw Error("대화를 시작하지 못했습니다.");
	location.assign(`/?onboarding=${state.room.id}`);
}
