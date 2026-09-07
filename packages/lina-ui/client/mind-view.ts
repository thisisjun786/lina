import type {
	EngineRecord,
	EngineSnapshot,
} from "../../lina-memory/src/engine/types.ts";
import { agentRequest, type RequestFn } from "./agent-editor.ts";
export type MindResponse =
	| {
			available: true;
			state: EngineSnapshot;
			processing: { error: string | null; [key: string]: unknown };
	  }
	| { available: false; reason: "room-not-open" | "native-memory-disabled" };

export function processingPresentation(processing: {
	error: string | null;
	[key: string]: unknown;
}): string {
	const n = (key: string) =>
		typeof processing[key] === "number" ? processing[key] : 0;
	return `대기 ${n("pending")} · 처리 중 ${n("sending")} · 변경 저장 ${n("changed")} · 변경 없음 ${n("unchanged")} · 재시도 중 ${n("retrying")} · 실패 ${n("failed")} · 저장된 기억 ${n("storedRecords")}${n("processedUnknown") ? ` · 이전 처리 ${n("processedUnknown")} (변경 여부 미확인)` : ""}${processing.error ? ` · 최근 처리 오류: ${processing.error}` : ""}`;
}

export function recordPresentation(record: EngineRecord, asOf = Date.now()) {
	return {
		subject: { user: "사용자", self: "에이전트 자신", relationship: "관계" }[
			record.subject
		],
		kind: {
			fact: "사실",
			interest: "관심",
			preference: "선호",
			concern: "걱정",
			mood: "기분",
			attitude: "태도",
		}[record.kind],
		support:
			record.support === "provisional"
				? "임시 추론"
				: record.evidence === "explicit"
					? "직접 표현"
					: "근거 있는 추론",
		status:
			record.status === "active" &&
			record.expiresAt !== null &&
			record.expiresAt <= asOf
				? "만료됨"
				: { active: "활성", resolved: "해결됨", retracted: "사용 중지됨" }[
						record.status
					],
		canRetract: record.status !== "retracted",
	};
}

export function createMindView(request: RequestFn = agentRequest) {
	let generation = 0;
	let controller: AbortController | undefined;
	let currentAgent = "";
	const load = async (agentId: string) => {
		const mine = ++generation;
		controller?.abort();
		controller = new AbortController();
		currentAgent = agentId;
		try {
			const value = (await request(
				`/api/agents/${encodeURIComponent(agentId)}/mind`,
				"GET",
				undefined,
				controller.signal,
			)) as MindResponse;
			if (mine !== generation) return undefined;
			if (value.available && value.state.agentId !== agentId)
				throw Error("다른 에이전트의 상태 응답입니다.");
			return value;
		} catch (error) {
			if (mine === generation) throw error;
			return undefined;
		}
	};
	const retract = async (agentId: string, id: string, revision: number) => {
		if (currentAgent !== agentId || controller?.signal.aborted)
			throw Error("마음 상태를 다시 열어주세요.");
		const mine = generation;
		try {
			const value = (await request(
				`/api/agents/${encodeURIComponent(agentId)}/mind/retract`,
				"POST",
				{ id, revision },
				controller?.signal,
			)) as MindResponse;
			if (mine !== generation) return undefined;
			if (value.available && value.state.agentId !== agentId)
				throw Error("다른 에이전트의 상태 응답입니다.");
			return value;
		} catch (error) {
			if (mine === generation) throw error;
			return undefined;
		}
	};
	return {
		load,
		retract,
		close() {
			generation++;
			controller?.abort();
		},
	};
}
