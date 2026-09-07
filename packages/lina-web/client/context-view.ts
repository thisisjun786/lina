import type {
	ContextClient,
	ContextSnapshot,
} from "../../lina-core/src/context-wire.ts";
import type { ContextModel } from "./context-model.ts";
import { element, setText } from "./render.ts";

const STATUS: Record<ContextSnapshot["compaction"]["status"], string> = {
	idle: "요약 없음",
	summarizing: "요약 중",
	accepted: "요약 적용됨",
	rejected: "요약 미적용",
	failed: "요약 실패 · 기존 맥락 유지",
};
const SERVICE: Record<ContextSnapshot["memory"]["service"], string> = {
	disabled: "미연결",
	ready: "연결됨 · 반영 시점 미확인",
	unavailable: "연결 실패",
};
export function createContextView(
	model: ContextModel,
	send: (frame: ContextClient) => boolean,
	changed: () => void,
) {
	const panel = element("context-panel", HTMLDetailsElement);
	const compact = element("compact-context", HTMLButtonElement),
		refresh = element("refresh-context", HTMLButtonElement);
	for (const [button, type] of [
		[compact, "compact"],
		[refresh, "context-refresh"],
	] as const)
		button.addEventListener("click", () => {
			const frame = model.command(type);
			if (!frame) return;
			model.sent();
			if (!send(frame)) model.failed();
			changed();
		});
	return () => {
		const state = model.state;
		panel.hidden = !state;
		if (!state) return;
		compact.disabled = !model.command("compact");
		refresh.disabled = !model.command("context-refresh");
		setText(
			element("context-status", HTMLParagraphElement),
			state.compaction.recoveryNeeded && !state.busy
				? "이전 요약 복원 필요"
				: STATUS[state.compaction.status],
		);
		const { tokens, contextWindow, injectionOmitted } = state.usage;
		setText(
			element("context-usage", HTMLParagraphElement),
			tokens !== null && contextWindow !== null
				? `대화 용량 약 ${tokens.toLocaleString("ko-KR")} / ${contextWindow.toLocaleString("ko-KR")} 토큰${injectionOmitted ? " · 참고 자료 일부 생략" : ""}`
				: "용량 미측정",
		);
		setText(
			element("working-goal", HTMLParagraphElement),
			state.working.goal || "없음",
		);
		setText(
			element("working-items", HTMLParagraphElement),
			[
				...state.working.decisions.map((item) => `결정 · ${item}`),
				...state.working.openItems.map((item) => `남은 일 · ${item}`),
				...state.working.nextSteps.map((item) => `다음 · ${item}`),
			].join("\n"),
		);
		const memory = state.memory;
		setText(
			element("memory-status", HTMLParagraphElement),
			SERVICE[memory.service],
		);
		setText(
			element("memory-delivery", HTMLParagraphElement),
			memory.service === "disabled"
				? ""
				: `기록 전달: 대기 ${memory.pending} · 전송 중 ${memory.sending} · 수신 확인 ${memory.accepted} · 확인 필요 ${memory.unknown} · 실패 ${memory.failed}`,
		);
		const recall = element("memory-recall", HTMLParagraphElement);
		recall.hidden = !memory.recallText;
		setText(recall, memory.recallText);
		const error = element("context-error", HTMLParagraphElement);
		error.hidden = !model.error;
		setText(error, model.error);
	};
}
