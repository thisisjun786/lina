import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRegular } from "../../lina-core/src/attachments/filesystem.ts";
import { canonicalLifeJson } from "../../lina-core/src/world/life-json.ts";
import { authorRecord } from "./author-native-policy.ts";

export const readProbeRecord = (path: string) =>
	authorRecord(JSON.parse(Buffer.from(readRegular(path)).toString("utf8")));

export function probeTurnText(raw: unknown): string {
	const turn = authorRecord(raw);
	if (turn["status"] !== "completed" || !Array.isArray(turn["items"]))
		throw Error("Native turn incomplete");
	const items = turn["items"].map(authorRecord);
	if (
		items.some(
			(i) =>
				!["userMessage", "agentMessage", "reasoning"].includes(
					String(i["type"]),
				),
		)
	)
		throw Error("Unexpected native item");
	const messages = items.filter((i) => i["type"] === "agentMessage");
	if (
		!messages.length ||
		messages.some((i) => typeof i["text"] !== "string" || !i["text"])
	)
		throw Error("Empty native output");
	return messages.map((i) => i["text"]).join("\n");
}

/** Validate the entire completed ledger before opening any persistent thread. */
export function completedProbeState(
	root: string,
	model: string,
	roles: readonly string[],
) {
	const binding = readProbeRecord(join(root, "binding.json"));
	if (binding["model"] !== model) throw Error("Frozen model changed");
	const threads = authorRecord(binding["threads"]);
	const ids = roles.map((role) => threads[role]);
	if (
		ids.some((id) => typeof id !== "string" || !id) ||
		new Set(ids).size !== roles.length
	)
		throw Error("Invalid saved threads");
	const expected = new Map(
		roles.map((role) => [
			role,
			{
				threadId: threads[role] as string,
				turns: new Map<string, { text: string; input: string }>(),
			},
		]),
	);
	const rounds = readdirSync(root).filter((name) => name.startsWith("round-"));
	if (!rounds.length)
		throw Error("Never-persisted threads; no automatic recreation");
	for (const name of rounds) {
		const directory = join(root, name);
		const roundId = name.slice(6);
		const complete = readProbeRecord(join(directory, "complete.json"));
		const source = readProbeRecord(join(directory, "input.json"));
		if (
			complete["roundId"] !== roundId ||
			complete["resumable"] !== true ||
			source["roundId"] !== roundId ||
			typeof source["input"] !== "string" ||
			!Array.isArray(complete["results"]) ||
			complete["results"].length !== roles.length
		)
			throw Error("Invalid durable completion");
		const seen = new Set<string>();
		for (const raw of complete["results"]) {
			const result = authorRecord(raw);
			const role = String(result["role"]);
			const saved = expected.get(role);
			const turnId = result["turnId"];
			if (
				!saved ||
				seen.has(role) ||
				result["threadId"] !== saved.threadId ||
				typeof turnId !== "string" ||
				!turnId ||
				saved.turns.has(turnId) ||
				typeof result["text"] !== "string" ||
				!result["text"] ||
				!("usage" in result)
			)
				throw Error("Invalid completed role");
			seen.add(role);
			const captured = readProbeRecord(join(directory, `result-${role}.json`));
			const intent = readProbeRecord(join(directory, `intent-${role}.json`));
			const started = readProbeRecord(join(directory, `turn-${role}.json`));
			if (
				canonicalLifeJson(captured) !== canonicalLifeJson(result) ||
				intent["key"] !== `${roundId}-${role}` ||
				intent["threadId"] !== saved.threadId ||
				typeof intent["input"] !== "string" ||
				started["threadId"] !== saved.threadId ||
				started["turnId"] !== turnId
			)
				throw Error("Completed role evidence mismatch");
			saved.turns.set(turnId, { text: result["text"], input: intent["input"] });
		}
	}
	return expected;
}

export function verifyProbeHistory(
	raw: unknown,
	expected: {
		threadId: string;
		turns: Map<string, { text: string; input: string }>;
	},
): void {
	const thread = authorRecord(authorRecord(raw)["thread"]);
	const turns = thread["turns"];
	if (
		thread["id"] !== expected.threadId ||
		!Array.isArray(turns) ||
		turns.length !== expected.turns.size
	)
		throw Error("Unsettled native history");
	const seen = new Set<string>();
	for (const rawTurn of turns) {
		const turn = authorRecord(rawTurn);
		const id = String(turn["id"]);
		const saved = expected.turns.get(id);
		if (!saved || seen.has(id) || probeTurnText(turn) !== saved.text)
			throw Error("Native completion evidence mismatch");
		seen.add(id);
		const users = (turn["items"] as unknown[])
			.map(authorRecord)
			.filter((i) => i["type"] === "userMessage");
		const content = users[0]?.["content"];
		if (
			users.length !== 1 ||
			!Array.isArray(content) ||
			content.length !== 1 ||
			authorRecord(content[0])["type"] !== "text" ||
			typeof authorRecord(content[0])["text"] !== "string" ||
			authorRecord(content[0])["text"] !== saved.input
		)
			throw Error("Native input evidence mismatch");
	}
}
