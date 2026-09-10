import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	fsyncDirectory,
	readRegular,
	writeExclusive,
} from "../../lina-core/src/attachments/filesystem.ts";
import { authorRecord } from "./author-native-policy.ts";
import type { ProbeCapture } from "./moirai-probe-transport.ts";
import {
	PROBE_MAX_WIRE_BYTES,
	probeProviderText,
	verifyProbeUsage,
	verifyProbeWire,
} from "./moirai-probe-transport.ts";

// Four roles x up to four rounds x input/output and two text copies, including JSON overhead.
export const PROBE_MAX_RECORD_BYTES = 4 * 4 * 4 * PROBE_MAX_WIRE_BYTES;
export function writeProbeRecord(path: string, value: unknown): void {
	const bytes = Buffer.from(JSON.stringify(value));
	if (bytes.byteLength > PROBE_MAX_RECORD_BYTES)
		throw Error("Probe record exceeds replay byte limit");
	writeExclusive(path, bytes);
	fsyncDirectory(dirname(path));
}

export const readProbeRecord = (path: string) =>
	authorRecord(
		JSON.parse(
			Buffer.from(readRegular(path, PROBE_MAX_RECORD_BYTES)).toString("utf8"),
		),
	);

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
				turns: new Map<
					string,
					{ text: string; input: string; capture: ProbeCapture }
				>(),
			},
		]),
	);
	const rounds = readdirSync(root).filter((name) => name.startsWith("round-"));
	if (!rounds.length)
		throw Error("Never-persisted threads; no automatic recreation");
	const numbered = rounds.map((name) => {
		const directory = join(root, name);
		const allowed = new Set([
			"input.json",
			"complete.json",
			...roles.flatMap((role) =>
				[
					"intent",
					"turn",
					"result",
					"native",
					"final-native",
					"persisted-native",
				].map((kind) => `${kind}-${role}.json`),
			),
		]);
		if (readdirSync(directory).some((name) => !allowed.has(name)))
			throw Error("Contradictory or unexpected completed-round evidence");
		const roundId = name.slice(6);
		const complete = readProbeRecord(join(directory, "complete.json"));
		const source = readProbeRecord(join(directory, "input.json"));
		const sequence = complete["sequence"];
		const results = complete["results"];
		if (
			complete["roundId"] !== roundId ||
			complete["resumable"] !== true ||
			source["roundId"] !== roundId ||
			typeof source["input"] !== "string" ||
			!Array.isArray(results) ||
			results.length !== roles.length
		)
			throw Error("Invalid durable completion");
		if (
			typeof sequence !== "number" ||
			!Number.isSafeInteger(sequence) ||
			sequence < 1 ||
			source["sequence"] !== sequence
		)
			throw Error("Invalid durable round sequence");
		return {
			directory,
			roundId,
			results,
			sequence,
			sourceInput: source["input"],
		};
	});
	const ordered = [...numbered].sort((a, b) => a.sequence - b.sequence);
	if (ordered.some(({ sequence }, index) => sequence !== index + 1))
		throw Error("Invalid durable round sequence");
	const previousCaptures = new Map<string, ProbeCapture>();
	for (const { directory, roundId, results, sourceInput } of ordered) {
		const seen = new Set<string>();
		for (const raw of results) {
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
			const capture = authorRecord(result["capture"]);
			const input = capture["input"];
			const output = capture["output"];
			const text = capture["text"];
			const usage = capture["usage"];
			if (
				!isDeepStrictEqual(captured, result) ||
				intent["key"] !== `${roundId}-${role}` ||
				intent["threadId"] !== saved.threadId ||
				typeof intent["input"] !== "string" ||
				started["threadId"] !== saved.threadId ||
				started["turnId"] !== turnId ||
				!Array.isArray(input) ||
				!Array.isArray(output) ||
				typeof text !== "string" ||
				text !== result["text"] ||
				probeProviderText(output) !== result["text"] ||
				!isDeepStrictEqual(usage, result["usage"])
			)
				throw Error("Completed role evidence mismatch");
			const envelope = authorRecord(JSON.parse(intent["input"]));
			const expectedInput =
				role === "moirai"
					? {
							input: sourceInput,
							proposals: roles
								.filter((r) => r !== "moirai")
								.map((role) => ({
									role,
									text: authorRecord(
										results.find((r) => authorRecord(r)["role"] === role),
									)["text"],
								})),
						}
					: sourceInput;
			const actualInput =
				role === "moirai" && typeof envelope["input"] === "string"
					? JSON.parse(envelope["input"])
					: envelope["input"];
			if (
				!isDeepStrictEqual(
					{ ...envelope, input: actualInput },
					{ roundId, role, input: expectedInput },
				)
			)
				throw Error("Role intent differs from recorded source");
			const validatedCapture: ProbeCapture = { input, output, text, usage };
			verifyProbeUsage(usage);
			verifyProbeWire(
				validatedCapture.input,
				intent["input"],
				previousCaptures.get(role) ?? null,
			);
			previousCaptures.set(role, validatedCapture);
			saved.turns.set(turnId, {
				text: result["text"],
				input: intent["input"],
				capture: validatedCapture,
			});
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
	const durableOrder = [...expected.turns.keys()];
	const seen = new Set<string>();
	for (let index = 0; index < turns.length; index++) {
		const turn = authorRecord(turns[index]);
		const id = String(turn["id"]);
		const saved = expected.turns.get(id);
		if (!saved || seen.has(id) || probeTurnText(turn) !== saved.text)
			throw Error("Native completion evidence mismatch");
		if (id !== durableOrder[index]) throw Error("Native turn order mismatch");
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
