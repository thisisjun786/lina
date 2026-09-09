import { Type } from "typebox";
import type { ConversationStore } from "../../../lina-core/src/agents/conversation.ts";
import {
	composePersonaPrompt,
	sharedPersonaBehavior,
} from "../../../lina-core/src/agents/persona.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { emptyDynamics } from "../../../lina-core/src/agents/validation.ts";
import {
	type SourceLookup,
	type SourceProof,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import type {
	CurrentPersonaSnapshot,
	SharedPersonaView,
} from "../../../lina-core/src/world/life-types.ts";
import type { EngineState } from "../../../lina-memory/src/engine/types.ts";
import type { ContextServices } from "../context/port.ts";
import type { LinaHost } from "../host.ts";
import { defaultConversation, preferenceInstructions } from "./conversation.ts";
import { firstOrdinaryReplyInstructions } from "./first-conversation.ts";
import { nativePersonaContext } from "./native-context.ts";

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
		memoryMode?: "automatic" | "disabled" | (() => "automatic" | "disabled");
		nativeDynamics?: boolean;
		allowNativeGrowth?: () => boolean;
		nativeState?: () => EngineState;
		sourceLookup?: SourceLookup;
		sharedGrowth?: () => SharedPersonaView | null;
		currentPersona?: () => CurrentPersonaSnapshot | null;
	} = {},
) {
	const lookup: SourceLookup = options.sourceLookup ?? (() => undefined);
	const memoryMode = () =>
		typeof options.memoryMode === "function"
			? options.memoryMode()
			: (options.memoryMode ?? "disabled");
	const snapshot = () => {
		const mode = memoryMode();
		const profile = agents.get(agentId);
		if (!profile) throw Error("Agent persona missing");
		const configured = options.conversations?.get(agentId);
		const conversation = configured?.revision
			? configured
			: defaultConversation(agentId);
		const learned = agents.modelDynamics(agentId, lookup);
		const permittedPreferences = options.conversations?.modelPreferences(
			agentId,
			lookup,
		);
		const shared = structuredClone(options.sharedGrowth?.() ?? null);
		const currentPersona = structuredClone(options.currentPersona?.() ?? null);
		const authoredContext = options.authoredContext?.();
		const nativeContext =
			options.nativeDynamics && (options.allowNativeGrowth?.() ?? true)
				? nativePersonaContext(profile, options.nativeState?.(), lookup)
				: { text: "", stamp: "" };
		const compiled = composePersonaPrompt(
			base,
			profile,
			options.nativeDynamics ? emptyDynamics() : learned.dynamics,
			{
				conversation,
				authoredContext,
				sharedGrowth: shared,
				currentPersona,
				memoryMode: mode,
			},
		);
		const preferences = permittedPreferences?.items ?? [];
		const userContext = options.userContext?.() ?? "";
		const systemPrompt =
			compiled.systemPrompt +
			nativeContext.text +
			preferenceInstructions(preferences) +
			userContext +
			(options.firstOrdinaryReply?.()
				? firstOrdinaryReplyInstructions({ userContext })
				: "") +
			(options.nativeDynamics && mode === "automatic"
				? "\n\n[네이티브 기억 처리]\n대화가 끝난 뒤 별도 엔진이 사용자의 명시적 대화 선호, 근거 있는 관찰, 정정과 기억 철회를 검증하여 저장한다. 기억 조회 도구가 읽기 전용이라는 이유로 저장이나 철회 기능이 없다고 말하지 않는다. 아직 처리 결과를 확인하지 않았다면 저장 또는 철회가 이미 완료됐다고 주장하지 않는다. 철회는 해당 기억의 사용 중지이며 대화 원문 삭제가 아니다. 사용자에게 구현 설명은 필요한 경우에만 한다."
				: "");
		services.systemTokens = services.estimateText(systemPrompt);
		if (
			services.contextWindow &&
			services.systemTokens > services.contextWindow - services.reserveTokens
		)
			throw Error("Persona exceeds the available context budget");
		const proofs = structuredClone([
			learned.sourceProofs,
			permittedPreferences?.sourceProofs ?? [],
		]);
		return {
			systemPrompt,
			beforeDeliver: () => {
				if (memoryMode() !== mode)
					throw Error("Memory policy changed before dispatch");
				if (
					options.nativeDynamics &&
					((options.allowNativeGrowth?.() ?? true)
						? nativePersonaContext(profile, options.nativeState?.(), lookup)
								.stamp
						: "") !== nativeContext.stamp
				)
					throw Error("Native persona source changed before dispatch");
				if (
					proofs.some((p) => p.length && !sourceProofsCurrent(p, lookup)) ||
					JSON.stringify(agents.modelDynamics(agentId, lookup).dynamics) !==
						JSON.stringify(learned.dynamics) ||
					JSON.stringify(
						options.conversations?.modelPreferences(agentId, lookup).items ??
							[],
					) !== JSON.stringify(preferences)
				)
					throw Error("Persona source provenance changed before dispatch");
				if (
					agents.get(agentId)?.revision !== profile.revision ||
					JSON.stringify(options.sharedGrowth?.() ?? null) !==
						JSON.stringify(shared) ||
					JSON.stringify(options.currentPersona?.() ?? null) !==
						JSON.stringify(currentPersona) ||
					JSON.stringify(options.conversations?.get(agentId)) !==
						JSON.stringify(configured) ||
					options.authoredContext?.() !== authoredContext ||
					(options.userContext?.() ?? "") !== userContext
				)
					throw Error("Persona or shared growth changed before dispatch");
			},
		};
	};
	const refresh = () => snapshot().systemPrompt;
	refresh();
	host.on("before_agent_start", () => snapshot());
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

			const shared = structuredClone(options.sharedGrowth?.() ?? null),
				currentPersona = structuredClone(options.currentPersona?.() ?? null),
				behavior = sharedPersonaBehavior(
					profile,
					currentPersona
						? {
								...currentPersona.worldView,
								...currentPersona.composedBehavior,
							}
						: shared,
				);
			const learned = agents.modelDynamics(agentId, lookup),
				native = options.nativeState?.();
			const records = structuredClone(
				(native?.records ?? []).filter(
					(r) =>
						r.subject !== "user" &&
						r.sourceProofs &&
						sourceProofsCurrent(r.sourceProofs, lookup),
				),
			);
			const proofs: SourceProof[][] = structuredClone(
				options.nativeDynamics
					? records.map((r) => r.sourceProofs ?? [])
					: [learned.sourceProofs],
			);
			const text =
				params.section === "growth"
					? JSON.stringify({
							shared: {
								traits: behavior.traits,
								habits: behavior.habits,
								attitudes: behavior.attitudes,
							},
							learned: options.nativeDynamics
								? {
										revision: native?.revision ?? 0,
										records: records.map((r) => ({
											subject: r.subject,
											kind: r.kind,
											key: r.key,
											text: r.text,
										})),
									}
								: {
										revision: learned.dynamics.revision,
										mood: learned.dynamics.mood?.label ?? null,
										interests: learned.dynamics.interests,
										preferences: learned.dynamics.preferences,
										relationship: learned.dynamics.relationship,
									},
						})
					: params.section === "appearance"
						? profile.appearance
						: profile.profile;
			const beforeDeliver = () => {
				if (
					options.nativeDynamics &&
					records.some(
						(row) =>
							!options
								.nativeState?.()
								.records.some(
									(current) => JSON.stringify(current) === JSON.stringify(row),
								),
					)
				)
					throw Error("Persona native memory changed before delivery");
				if (
					!options.nativeDynamics &&
					JSON.stringify(agents.modelDynamics(agentId, lookup).dynamics) !==
						JSON.stringify(learned.dynamics)
				)
					throw Error("Persona learned state changed before delivery");
				if (
					agents.get(agentId)?.revision !== profile.revision ||
					JSON.stringify(options.sharedGrowth?.() ?? null) !==
						JSON.stringify(shared) ||
					JSON.stringify(options.currentPersona?.() ?? null) !==
						JSON.stringify(currentPersona)
				)
					throw Error("Persona or shared growth changed before delivery");
				if (
					params.section === "growth" &&
					proofs.some((p) => p.length && !sourceProofsCurrent(p, lookup))
				)
					throw Error("Persona source provenance changed before delivery");
			};
			return {
				beforeDeliver,
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
	return Object.assign(refresh, { prepare: snapshot });
}
