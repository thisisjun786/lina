import type { WorkingState } from "./context/types.ts";

export type ContextClient = {
	type: "context-refresh" | "compact";
	sessionId: string;
};
export type ContextSnapshot = {
	sessionId: string;
	epoch: string;
	revision: number;
	busy: boolean;
	usage: {
		tokens: number | null;
		contextWindow: number | null;
		estimated: boolean;
		injectionTokens: number;
		injectionOmitted: boolean;
	};
	compaction: {
		status: "idle" | "summarizing" | "accepted" | "rejected" | "failed";
		activeId: string | null;
		recoveryNeeded: boolean;
		sourceCount: number;
	};
	working: WorkingState;
	memory: {
		service: "disabled" | "ready" | "unavailable";
		pending: number;
		sending: number;
		accepted: number;
		unknown: number;
		failed: number;
		withheld: number;
		freshness: "unknown";
		recallText: string;
	};
};
export type ContextServer =
	| { type: "context-state"; state: ContextSnapshot }
	| { type: "context-error"; message: string };
type Fields = Record<string, unknown>;
function object(raw: unknown): Fields | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Fields)
		: undefined;
}
function decode(raw: unknown): Fields | undefined {
	if (typeof raw !== "string" || raw.length > 65536) return;
	try {
		return object(JSON.parse(raw));
	} catch {
		return;
	}
}
function string(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}
function id(value: unknown): value is string {
	return string(value, 256) && value.length > 0;
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function list(value: unknown, max: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 8 &&
		value.every((item) => string(item, max))
	);
}

export function parseContextClient(raw: unknown): ContextClient | undefined {
	const value = decode(raw);
	if (
		!value ||
		(value["type"] !== "compact" && value["type"] !== "context-refresh") ||
		!id(value["sessionId"]) ||
		Object.keys(value).length !== 2
	)
		return;
	return { type: value["type"], sessionId: value["sessionId"] };
}
function parseSnapshot(raw: unknown): ContextSnapshot | undefined {
	const value = object(raw),
		usage = object(value?.["usage"]),
		compaction = object(value?.["compaction"]),
		working = object(value?.["working"]),
		memory = object(value?.["memory"]);
	if (
		!value ||
		!usage ||
		!compaction ||
		!working ||
		!memory ||
		!id(value["sessionId"]) ||
		!id(value["epoch"]) ||
		!integer(value["revision"]) ||
		typeof value["busy"] !== "boolean"
	)
		return;
	if (
		!(usage["tokens"] === null || integer(usage["tokens"])) ||
		!(usage["contextWindow"] === null || integer(usage["contextWindow"])) ||
		typeof usage["estimated"] !== "boolean" ||
		!integer(usage["injectionTokens"]) ||
		usage["injectionTokens"] > 2048 ||
		typeof usage["injectionOmitted"] !== "boolean"
	)
		return;
	if (
		!(compaction["activeId"] === null || id(compaction["activeId"])) ||
		!integer(compaction["sourceCount"]) ||
		typeof compaction["recoveryNeeded"] !== "boolean" ||
		!["idle", "summarizing", "accepted", "rejected", "failed"].includes(
			String(compaction["status"]),
		)
	)
		return;
	if (
		!integer(working["revision"]) ||
		!string(working["goal"], 1000) ||
		!list(working["decisions"], 300) ||
		!list(working["openItems"], 300) ||
		!list(working["nextSteps"], 300) ||
		!list(working["sourceEntryIds"], 256)
	)
		return;
	if (
		!["disabled", "ready", "unavailable"].includes(String(memory["service"])) ||
		memory["freshness"] !== "unknown" ||
		!string(memory["recallText"], 4096) ||
		!(memory["withheld"] === undefined || integer(memory["withheld"])) ||
		!["pending", "sending", "accepted", "unknown", "failed"].every((key) =>
			integer(memory[key]),
		)
	)
		return;
	// Each field above has been independently bounded; discard unknown response properties.
	return {
		sessionId: value["sessionId"],
		epoch: value["epoch"],
		revision: value["revision"],
		busy: value["busy"],
		usage: {
			tokens: usage["tokens"],
			contextWindow: usage["contextWindow"],
			estimated: usage["estimated"],
			injectionTokens: usage["injectionTokens"],
			injectionOmitted: usage["injectionOmitted"],
		},
		compaction: {
			status: compaction["status"] as ContextSnapshot["compaction"]["status"],
			activeId: compaction["activeId"],
			recoveryNeeded: compaction["recoveryNeeded"],
			sourceCount: compaction["sourceCount"],
		},
		working: {
			revision: working["revision"],
			goal: working["goal"],
			decisions: working["decisions"],
			openItems: working["openItems"],
			nextSteps: working["nextSteps"],
			sourceEntryIds: working["sourceEntryIds"],
		},
		memory: {
			service: memory["service"] as ContextSnapshot["memory"]["service"],
			pending: memory["pending"] as number,
			sending: memory["sending"] as number,
			accepted: memory["accepted"] as number,
			unknown: memory["unknown"] as number,
			failed: memory["failed"] as number,
			withheld: (memory["withheld"] as number | undefined) ?? 0,
			freshness: "unknown",
			recallText: memory["recallText"],
		},
	};
}
export function parseContextServer(raw: unknown): ContextServer | undefined {
	const value = decode(raw);
	if (value?.["type"] === "context-error" && string(value["message"], 1024))
		return { type: "context-error", message: value["message"] };
	if (value?.["type"] !== "context-state") return;
	const state = parseSnapshot(value["state"]);
	return state ? { type: "context-state", state } : undefined;
}
