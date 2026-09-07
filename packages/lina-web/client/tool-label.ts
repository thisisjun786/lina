import type { ToolMetadata } from "../../lina-core/src/protocol.ts";
import { TOOL_NAME_MAX_CHARS } from "../../lina-core/src/protocol.ts";

export const COMMAND_DETAIL_MAX_CHARS = 100;
const GENERIC_LABEL = "도구 결과";
const NAMES: Record<string, string> = {
	read: "파일 읽기",
	write: "파일 쓰기",
	edit: "파일 수정",
	bash: "명령 실행",
	grep: "내용 검색",
	find: "파일 찾기",
	ls: "폴더 확인",
	lina_notepad_read: "노트 읽기",
	lina_notepad_append: "노트에 추가",
	lina_status: "상태 확인",
	lina_attachment_read: "첨부파일 읽기",
	lina_history_search: "대화 검색",
	lina_context_expand: "이전 맥락 읽기",
	lina_context_update: "진행 상태 기록",
};

/** Human label for a tool name; unknown names are shown verbatim but bounded. */
export function toolLabel(name: string | undefined): string {
	if (name === undefined || name.length === 0) return GENERIC_LABEL;
	return Object.hasOwn(NAMES, name)
		? (NAMES[name] ?? name)
		: name.slice(0, TOOL_NAME_MAX_CHARS);
}

export type ToolTone = "" | "failed";
/** Keep successful/legacy rows quiet; a confirmed failure remains visible. */
export function toolSummary(tool: ToolMetadata | undefined): {
	label: string;
	badge: string;
	tone: ToolTone;
} {
	const label = toolLabel(tool?.name);
	if (tool?.isError === true) return { label, badge: "실패", tone: "failed" };
	return { label, badge: "", tone: "" };
}

function plain(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are display noise
	return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * Deterministic one-line target for an approval card. Long or multiline
 * commands get a neutral size descriptor; nothing here judges safety.
 */
export function approvalDescriptor(name: string, inputJson: string): string {
	let input: unknown;
	try {
		input = JSON.parse(inputJson);
	} catch {
		return "입력 확인 불가";
	}
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return "입력 확인 불가";
	const record = input as Record<string, unknown>;
	const keys = Object.keys(record);
	const command = record["command"];
	if (typeof command === "string") {
		const lines = command.split("\n").length;
		if (lines > 1 || command.length > COMMAND_DETAIL_MAX_CHARS)
			return `명령 ${command.length}자 · ${lines}줄`;
		return plain(command);
	}
	const path = record["path"];
	if (typeof path === "string") {
		const shown = plain(path);
		return shown.length > COMMAND_DETAIL_MAX_CHARS
			? `…${shown.slice(shown.length - (COMMAND_DETAIL_MAX_CHARS - 1))}`
			: shown;
	}
	void name;
	return keys.length === 0 ? "인수 없음" : `인수 ${keys.length}개`;
}
