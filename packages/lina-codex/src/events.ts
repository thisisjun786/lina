export type ProjectedEntry = {
	type: "message" | "custom_message";
	id: string;
	timestamp: string;
	message?: {
		role: "user" | "assistant" | "toolResult";
		content: Array<{ type: "text"; text: string }>;
		stopReason?: "stop";
	};
	customType?: string;
	content?: string;
	display?: boolean;
	details?: unknown;
	codex?: { turnId: string; ordinal: number; nativeItemId: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(ms: unknown): string {
	if (typeof ms === "number" && Number.isFinite(ms))
		return new Date(ms).toISOString();
	return new Date().toISOString();
}

function userText(content: unknown): string {
	if (!Array.isArray(content))
		return typeof content === "string" ? content : "";
	return content
		.flatMap((item) => {
			const block = isRecord(item) ? item : undefined;
			return block?.["type"] === "text" && typeof block["text"] === "string"
				? [block["text"]]
				: [];
		})
		.join("\n\n");
}

export function projectCodexItem(
	item: unknown,
	completedAtMs?: unknown,
	identity?: { turnId: string; ordinal: number },
): ProjectedEntry | undefined {
	if (
		!isRecord(item) ||
		typeof item["id"] !== "string" ||
		typeof item["type"] !== "string"
	)
		return;
	const timestamp = iso(completedAtMs);
	const origin = identity
		? { codex: { ...identity, nativeItemId: item["id"] } }
		: {};
	const id = (role: string) =>
		identity
			? `codex:${identity.turnId}:${role}:${identity.ordinal}`
			: (item["id"] as string);
	if (item["type"] === "userMessage") {
		return {
			type: "message",
			id: id("user"),
			...origin,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: userText(item["content"]) }],
			},
		};
	}
	if (item["type"] === "agentMessage") {
		const text = typeof item["text"] === "string" ? item["text"] : "";
		return {
			type: "message",
			id: id("assistant"),
			...origin,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				// CompanionMemory also requires the enclosing user request to have
				// settled successfully; commentary/unknown phases are not final.
				...(item["phase"] === "final_answer"
					? { stopReason: "stop" as const }
					: {}),
			},
		};
	}
	if (item["type"] === "dynamicToolCall" || item["type"] === "mcpToolCall") {
		const name =
			typeof item["tool"] === "string"
				? item["tool"]
				: typeof item["name"] === "string"
					? item["name"]
					: "tool";
		return {
			type: "message",
			id: id("toolResult"),
			...origin,
			timestamp,
			message: {
				role: "toolResult",
				content: [{ type: "text", text: name }],
			},
		};
	}
}

export function projectNotice(
	id: string,
	text: string,
	details: unknown,
): ProjectedEntry {
	return {
		type: "custom_message",
		id,
		timestamp: new Date().toISOString(),
		customType: "lina.development",
		content: text,
		display: true,
		details,
	};
}

export function eventsFromNotification(
	method: string,
	params: unknown,
	identity?: { turnId: string; ordinal: number },
): unknown[] {
	if (!isRecord(params)) return [];
	switch (method) {
		case "turn/started":
			return [{ type: "agent_start" }];
		case "item/agentMessage/delta": {
			const delta = params["delta"];
			return typeof delta === "string"
				? [
						{
							type: "message_update",
							assistantMessageEvent: { type: "text_delta", delta },
						},
					]
				: [];
		}
		case "item/completed": {
			const entry = projectCodexItem(
				params["item"],
				params["completedAtMs"],
				identity,
			);
			if (!entry) return [];
			const events: unknown[] = [{ type: "entry_appended", entry }];
			if (entry.message?.role === "assistant") {
				events.push({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_end",
						content: entry.message.content[0]?.text ?? "",
					},
				});
			}
			return events;
		}
		case "turn/completed": {
			const turn = isRecord(params["turn"]) ? params["turn"] : undefined;
			const status = turn?.["status"];
			const events: unknown[] = [];
			if (status === "failed" && turn) {
				const error = isRecord(turn["error"]) ? turn["error"] : undefined;
				events.push({
					type: "continuation_error",
					errorMessage:
						typeof error?.["message"] === "string"
							? error["message"]
							: "Codex turn failed",
				});
			}
			if (status === "interrupted") {
				events.push({
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "aborted",
						errorMessage: "Run interrupted",
					},
				});
			}
			events.push({ type: "agent_settled" });
			return events;
		}
		case "error": {
			const error = isRecord(params["error"]) ? params["error"] : params;
			return [
				{
					type: "continuation_error",
					errorMessage:
						typeof error["message"] === "string"
							? error["message"]
							: "Codex error",
				},
			];
		}
		default:
			return [];
	}
}

export function historyFromTurns(turns: unknown): ProjectedEntry[] {
	if (!Array.isArray(turns)) return [];
	const entries: ProjectedEntry[] = [];
	for (const turn of turns) {
		if (!isRecord(turn) || !Array.isArray(turn["items"])) continue;
		const at =
			typeof turn["completedAt"] === "number"
				? turn["completedAt"] * 1000
				: typeof turn["startedAt"] === "number"
					? turn["startedAt"] * 1000
					: Date.now();
		const ordinals = new Map<string, number>();
		for (const item of turn["items"]) {
			const projected = projectCodexItem(item, at);
			if (!projected?.message) continue;
			const role = projected.message.role;
			const ordinal = ordinals.get(role) ?? 0;
			ordinals.set(role, ordinal + 1);
			const entry = projectCodexItem(
				item,
				at,
				typeof turn["id"] === "string"
					? { turnId: turn["id"], ordinal }
					: undefined,
			);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}
