import { TASK_ID_PATTERN, TaskError } from "../task-types.ts";

export const OWNER_MAX = 48;
export const TITLE_MAX = 200;
export const PROMPT_MAX = 16000;
export const REQUEST_MAX = 128;
export const MODEL_MAX = 256;

export function field(value: unknown, label: string, max: number): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		value.includes("\0")
	)
		throw new TaskError("invalid_input", `invalid ${label}`);
	return value;
}

export function ownerId(value: unknown): string {
	const id = field(value, "ownerAgentId", OWNER_MAX);
	if (!TASK_ID_PATTERN.test(id))
		throw new TaskError("invalid_input", "invalid ownerAgentId");
	return id;
}

export function taskId(value: unknown): string {
	if (typeof value !== "string" || !TASK_ID_PATTERN.test(value))
		throw new TaskError("invalid_input", "invalid task id");
	return value;
}

export function expectedRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TaskError("invalid_input", "Invalid expectedRevision");
	return value;
}
