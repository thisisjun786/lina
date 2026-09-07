import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentConversationSummary,
	type PublicListMessage,
	summaryFromSnapshot,
} from "../../../lina-client/src/agent-list.ts";
import {
	checkedDirectory,
	checkedRegular,
	readRegular,
} from "../../../lina-core/src/attachments/filesystem.ts";
import { CONVERSATION_FILTER } from "../../../lina-core/src/conversation.ts";
import { PREVIEW_MAX_CHARS } from "../../../lina-core/src/protocol.ts";
import { validateBinding } from "../../../lina-core/src/session-binding.ts";
import { type AgentFleet, validAgentId } from "./manager.ts";

function emptySummary(
	agentId: string,
	available: boolean,
): AgentConversationSummary {
	return {
		agentId,
		available,
		sessionId: null,
		revision: 0,
		latestMessage: null,
		confirmationCount: null,
		running: null,
	};
}

/** Reads one committed public row. Never starts a room, initializes a store or replays an engine. */
function storedSummary(
	root: string,
	agentId: string,
): AgentConversationSummary {
	const directory = agentId === "lina" ? root : join(root, "agents", agentId);
	const path = join(directory, "state.sqlite");
	const manifest = join(directory, "binding.json");
	const exists = (file: string) =>
		Boolean(lstatSync(file, { throwIfNoEntry: false }));
	if (!exists(path) && !exists(manifest)) return emptySummary(agentId, true);
	checkedDirectory(directory, false);
	checkedRegular(path);
	for (const suffix of ["-wal", "-shm", "-journal"])
		checkedRegular(`${path}${suffix}`, false);
	const binding = validateBinding(
		JSON.parse(new TextDecoder().decode(readRegular(manifest, 65536))),
	);
	if (binding.botId !== agentId) throw Error("Foreign summary binding");
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("BEGIN");
		if (db.prepare("PRAGMA user_version").get()?.["user_version"] !== 1)
			throw Error("Unknown summary schema");
		const saved = db
			.prepare("SELECT value FROM meta WHERE key = 'binding'")
			.get()?.["value"];
		if (
			typeof saved !== "string" ||
			!isDeepStrictEqual(JSON.parse(saved), binding)
		)
			throw Error("Foreign summary store");
		const revision = Number(
			db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.[
				"value"
			],
		);
		if (!Number.isSafeInteger(revision) || revision < 0)
			throw Error("Invalid summary revision");
		// This predicate is the public conversation's existing storage projection.
		const row = db
			.prepare(
				`SELECT entry_id, seq, role, substr(text, 1, ?) AS text, timestamp FROM entries WHERE session_id = ? AND (${CONVERSATION_FILTER}) ORDER BY seq DESC LIMIT 1`,
			)
			.get(PREVIEW_MAX_CHARS, binding.sessionId);
		let latestMessage: PublicListMessage | null = null;
		if (row) {
			if (
				typeof row["entry_id"] !== "string" ||
				typeof row["seq"] !== "number" ||
				(row["role"] !== "user" && row["role"] !== "assistant") ||
				typeof row["text"] !== "string" ||
				typeof row["timestamp"] !== "string"
			)
				throw Error("Invalid public summary");
			latestMessage = {
				entryId: row["entry_id"],
				seq: row["seq"],
				role: row["role"],
				text: row["text"],
				timestamp: row["timestamp"],
			};
		}
		return {
			...emptySummary(agentId, true),
			sessionId: binding.sessionId,
			revision,
			latestMessage,
		};
	} finally {
		db.close();
	}
}

export function agentSummaries(
	fleet: Pick<AgentFleet, "agents" | "root" | "opened">,
): AgentConversationSummary[] {
	return fleet.agents.list().map(({ id }) => {
		try {
			if (!validAgentId(id)) throw Error("Invalid agent");
			const app = fleet.opened(id);
			if (app) {
				const snapshot = app.runtime.snapshot();
				const control = app.execution.snapshot();
				const count =
					control.sessionId === snapshot.sessionId
						? control.approvals.filter(
								(approval) =>
									approval.state === "pending" &&
									approval.expiresAt > Date.now(),
							).length
						: null;
				return summaryFromSnapshot(snapshot, count);
			}
			return storedSummary(fleet.root, id);
		} catch {
			return emptySummary(id, false);
		}
	});
}
