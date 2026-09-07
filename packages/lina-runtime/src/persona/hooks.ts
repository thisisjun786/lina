import { Type } from "typebox";
import type { ConversationStore } from "../../../lina-core/src/agents/conversation.ts";
import { composePersonaPrompt } from "../../../lina-core/src/agents/persona.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { emptyDynamics } from "../../../lina-core/src/agents/validation.ts";
import type { EngineState } from "../../../lina-memory/src/engine/types.ts";
import type { ContextServices } from "../context/port.ts";
import type { LinaHost } from "../host.ts";
import { defaultConversation, preferenceInstructions } from "./conversation.ts";
import { firstOrdinaryReplyInstructions } from "./first-conversation.ts";

export function installPersona(
	host: LinaHost,
	agents: AgentStore,
	agentId: string,
	base: string,
	services: ContextServices,
	options: {
		userContext?: (() => string) | undefined;
		firstOrdinaryReply?: (() => boolean) | undefined;
		authoredContext?: (() => string) | undefined;
		conversations?: ConversationStore | undefined;
		memoryMode?: "automatic" | "disabled";
		nativeDynamics?: boolean;
		nativeState?: () => EngineState;
	} = {},
): () => string {
	const refresh = () => {
		const profile = agents.get(agentId);
		if (!profile) throw Error("Agent persona missing");
		const configured = options.conversations?.get(agentId);
		const conversation = configured?.revision
			? configured
			: defaultConversation(agentId);
		const compiled = composePersonaPrompt(
			base,
			profile,
			options.nativeDynamics ? emptyDynamics() : agents.dynamics(agentId),
			{
				conversation,
				authoredContext: options.authoredContext?.(),
				memoryMode: options.memoryMode ?? "disabled",
			},
		);
		const preferences =
			options.conversations?.getPreferences(agentId).items ?? [];
		const userContext = options.userContext?.() ?? "";
		const systemPrompt =
			compiled.systemPrompt +
			preferenceInstructions(preferences) +
			userContext +
			(options.firstOrdinaryReply?.()
				? firstOrdinaryReplyInstructions({ userContext })
				: "") +
			(options.nativeDynamics
				? "\n\n[네이티브 기억 처리]\n대화가 끝난 뒤 별도 엔진이 사용자의 명시적 대화 선호, 근거 있는 관찰, 정정과 기억 철회를 검증하여 저장한다. 기억 조회 도구가 읽기 전용이라는 이유로 저장이나 철회 기능이 없다고 말하지 않는다. 아직 처리 결과를 확인하지 않았다면 저장 또는 철회가 이미 완료됐다고 주장하지 않는다. 철회는 해당 기억의 사용 중지이며 대화 원문 삭제가 아니다. 사용자에게 구현 설명은 필요한 경우에만 한다."
				: "");
		services.systemTokens = services.estimateText(systemPrompt);
		if (
			services.contextWindow &&
			services.systemTokens > services.contextWindow - services.reserveTokens
		)
			throw Error("Persona exceeds the available context budget");
		return systemPrompt;
	};
	refresh();
	host.on("before_agent_start", () => ({ systemPrompt: refresh() }));
	host.registerTool({
		name: "lina_persona_read",
		label: "페르소나 읽기",
		description:
			"Read your character profile, appearance lore, and recent learned changes only when relevant. Fictional biography is character setting, not a real lived memory or permission. Does not update identity.",
		parameters: Type.Object({
			section: Type.Union([
				Type.Literal("profile"),
				Type.Literal("appearance"),
				Type.Literal("growth"),
			]),
		}),
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const profile = agents.get(agentId);
			if (!profile) throw Error("Unknown agent");
			const text =
				params.section === "growth"
					? JSON.stringify({
							state: options.nativeState?.() ?? agents.dynamics(agentId),
							changes: options.nativeDynamics
								? []
								: agents.changes(agentId).slice(0, 8),
						})
					: params.section === "appearance"
						? profile.appearance
						: profile.profile;
			return {
				content: [
					{
						type: "text" as const,
						text: `Character reference data (${params.section}):\n${text.slice(0, 12000)}`,
					},
				],
				details: { agentId, section: params.section },
			};
		},
	});
	return refresh;
}
