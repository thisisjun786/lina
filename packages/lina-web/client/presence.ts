import type {
	ControlSnapshot,
	ToolRun,
} from "../../lina-core/src/control/types.ts";

function target(raw: unknown): string {
	if (typeof raw !== "string") return "";
	// Status labels are plain text; discard bidi/control characters and markup.
	const name =
		raw
			.split(/[\\/]/)
			.at(-1)
			?.replace(/[\p{Cc}\p{Cf}<>]/gu, "")
			.trim() ?? "";
	return name.length > 24 || /^[\da-f]{8}-[\da-f-]+$/i.test(name) ? "" : name;
}
/** Observed operation and its bounded target, never a claim of completion. */
export function operationLabel(tool: ToolRun): string {
	let input: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(tool.inputPreview);
		if (value && typeof value === "object" && !Array.isArray(value))
			input = value as Record<string, unknown>;
	} catch {
		/* Bounded previews can be truncated. */
	}
	const file = target(input["path"]) || "파일";
	switch (tool.name) {
		case "read":
			return `${file} 읽는 중`;
		case "write":
			return `${file} 저장하는 중`;
		case "edit":
			return `${file} 고치는 중`;
		case "grep":
			return "내용 찾는 중";
		case "find":
			return "파일 찾는 중";
		case "ls":
			return "폴더 살피는 중";
		case "lina_notepad_read":
			return "메모 읽는 중";
		case "lina_notepad_append":
			return "메모 남기는 중";
		case "lina_attachment_read":
			return "첨부파일 읽는 중";
		case "lina_history_search":
			return "지난 대화 찾는 중";
		case "lina_context_expand":
			return "지난 이야기 짚는 중";
		case "lina_context_update":
			return "진행 상황 정리 중";
		case "lina_status":
			return "현재 상황 살피는 중";
		case "bash": {
			const command = input["command"];
			// Only whole, simple invocations earn a specific label. Never execute or
			// infer the purpose of compound shell code from a substring.
			if (typeof command !== "string") break;
			if (
				/^(?:bun|npm|pnpm) (?:run )?(?:test|typecheck|lint)(?: --?[\w-]+)*\s*$/.test(
					command,
				)
			)
				return /test/.test(command) ? "테스트 돌리는 중" : "코드 확인하는 중";
			if (/^git (?:status|diff|log)(?: --?[\w-]+)*\s*$/.test(command))
				return "변경 사항 살피는 중";
			break;
		}
	}
	return "작업 처리 중";
}
export type ActivityInput = {
	connected: boolean;
	running: boolean;
	pending: boolean;
	requestStartedAt: string | undefined;
	control: ControlSnapshot | undefined;
	contextBusy: boolean;
};
export type ActivityStatus = {
	label: string;
	moving: boolean;
	startedAt: string | undefined;
};
export function activityStatus(input: ActivityInput): ActivityStatus | null {
	const { connected, control, running } = input;
	if (!connected)
		return { label: "연결 끊김", moving: false, startedAt: undefined };
	if (control?.cancelling)
		return { label: "중단하는 중", moving: false, startedAt: undefined };
	if (control?.approvals.some((a) => a.state === "pending"))
		return { label: "확인 기다리는 중", moving: false, startedAt: undefined };
	if (input.contextBusy)
		return {
			label: "지난 이야기 정리 중",
			moving: true,
			startedAt: input.requestStartedAt,
		};
	const active =
		control?.tools.filter(
			(t) => t.requestId === control.cancelRequestId && t.state === "running",
		) ?? [];
	if (running || control?.cancelRequestId) {
		const latest = active.sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		)[0];
		return {
			label: latest ? operationLabel(latest) : "답변 준비 중",
			moving: true,
			startedAt: input.requestStartedAt ?? latest?.createdAt,
		};
	}
	if (input.pending)
		return { label: "메시지 보내는 중", moving: false, startedAt: undefined };
	return null;
}
export function elapsedText(start: string | undefined, now: number): string {
	if (!start) return "";
	const seconds = Math.floor((now - Date.parse(start)) / 1000);
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	if (seconds < 60) return `${seconds}초`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
	return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}
