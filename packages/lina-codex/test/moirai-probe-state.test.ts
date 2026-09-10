import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	completedProbeState,
	verifyProbeHistory,
} from "../src/moirai-probe-state.ts";

const roots: string[] = [];
const roles = ["clotho"] as const;
const threadId = "thread-clotho";

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}

function ledger(): string {
	const root = mkdtempSync(join(tmpdir(), "moirai-probe-state-test-"));
	roots.push(root);
	writeJson(join(root, "binding.json"), {
		model: "test-model",
		threads: { clotho: threadId },
	});
	return root;
}

type WireCapture = {
	input: Record<string, unknown>[];
	output: Record<string, unknown>[];
	text: string;
	usage: unknown;
};

/** Mirrors the durable transport-capture shape main's moirai-probe-transport.ts validates. */
function buildCapture(
	input: string,
	text: string,
	previous: WireCapture | null,
): WireCapture {
	const userMessage = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: input }],
	};
	const assistantMessage = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text }],
	};
	return {
		input: previous
			? [...previous.input, ...previous.output, userMessage]
			: [userMessage],
		output: [assistantMessage],
		text,
		usage: null,
	};
}

function completeRound(
	root: string,
	name: string,
	sequence: unknown,
	options: {
		inputSequence?: unknown;
		previous?: WireCapture | null;
		capture?: WireCapture;
		resultPatch?: Record<string, unknown>;
	} = {},
): WireCapture {
	const roundId = name.slice(6);
	const directory = join(root, name);
	const sourceInput = `input-${roundId}`;
	const input = JSON.stringify({ roundId, role: "clotho", input: sourceInput });
	const text = `text-${roundId}`;
	const capture =
		options.capture ?? buildCapture(input, text, options.previous ?? null);
	const result = {
		role: "clotho",
		threadId,
		turnId: `turn-${roundId}`,
		text,
		usage: null,
		capture,
		...options.resultPatch,
	};
	const inputSequence =
		"inputSequence" in options ? options.inputSequence : sequence;
	const source: Record<string, unknown> = { roundId, input: sourceInput };
	const complete: Record<string, unknown> = {
		roundId,
		results: [result],
		resumable: true,
	};
	if (inputSequence !== undefined) source["sequence"] = inputSequence;
	if (sequence !== undefined) complete["sequence"] = sequence;
	mkdirSync(directory);
	writeJson(join(directory, "input.json"), source);
	writeJson(join(directory, "complete.json"), complete);
	writeJson(join(directory, "result-clotho.json"), result);
	writeJson(join(directory, "intent-clotho.json"), {
		key: `${roundId}-clotho`,
		threadId,
		input,
	});
	writeJson(join(directory, "turn-clotho.json"), {
		threadId,
		turnId: result.turnId,
	});
	return capture;
}

test("completed probe state orders reverse-lexical round directories by sequence", () => {
	const root = ledger();
	const first = completeRound(root, "round-z-first", 1);
	completeRound(root, "round-a-second", 2, { previous: first });

	const state = completedProbeState(root, "test-model", roles);
	expect([...(state.get("clotho")?.turns.keys() ?? [])]).toEqual([
		"turn-z-first",
		"turn-a-second",
	]);
	expect(state.get("clotho")?.turns.get("turn-a-second")?.capture).toEqual(
		buildCapture(
			JSON.stringify({
				roundId: "a-second",
				role: "clotho",
				input: "input-a-second",
			}),
			"text-a-second",
			first,
		),
	);
});

for (const [name, rounds] of [
	["missing", [[undefined]]],
	["duplicate", [[1], [1]]],
	["gap", [[1], [3]]],
	["noninteger", [[1.5]]],
	["mismatched", [[1, 2]]],
] as const) {
	test(`completed probe state rejects ${name} durable sequence evidence`, () => {
		const root = ledger();
		for (const [index, [sequence, inputSequence]] of rounds.entries())
			completeRound(
				root,
				`round-${name}-${index + 1}`,
				sequence,
				inputSequence === undefined ? {} : { inputSequence },
			);
		expect(() => completedProbeState(root, "test-model", roles)).toThrow(
			"Invalid durable round sequence",
		);
	});
}

test("completed probe state rejects a broken transport prefix between chronological rounds", () => {
	const root = ledger();
	completeRound(root, "round-first", 1);
	// Round two's capture drops round one's admitted prefix entirely.
	completeRound(root, "round-second", 2, { previous: null });

	expect(() => completedProbeState(root, "test-model", roles)).toThrow(
		"Prior wire history mismatch",
	);
});

test("completed probe state rejects a capture whose text disagrees with the completed result", () => {
	const root = ledger();
	const capture = buildCapture("input-round1", "text-round1", null);
	completeRound(root, "round-round1", 1, {
		capture: { ...capture, text: "different text" },
	});

	expect(() => completedProbeState(root, "test-model", roles)).toThrow(
		"Completed role evidence mismatch",
	);
});

test("completed probe state rejects capture output whose provider text disagrees with the completed result", () => {
	const root = ledger();
	const capture = buildCapture("input-round1", "text-round1", null);
	const tamperedOutput = [
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "a different provider text" }],
		},
	];
	completeRound(root, "round-round1", 1, {
		capture: { ...capture, output: tamperedOutput },
	});

	expect(() => completedProbeState(root, "test-model", roles)).toThrow(
		"Completed role evidence mismatch",
	);
});

test("completed probe state rejects a capture whose usage disagrees with the completed result", () => {
	const root = ledger();
	const capture = buildCapture("input-round1", "text-round1", null);
	completeRound(root, "round-round1", 1, {
		capture: {
			...capture,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	});

	expect(() => completedProbeState(root, "test-model", roles)).toThrow(
		"Completed role evidence mismatch",
	);
});

const expectedTurns = new Map([
	["turn-first", { text: "first reply", input: "first prompt" }],
	["turn-second", { text: "second reply", input: "second prompt" }],
]);

function history(ids: readonly ("turn-first" | "turn-second")[]) {
	const turns = {
		"turn-first": {
			id: "turn-first",
			status: "completed",
			items: [
				{
					type: "userMessage",
					content: [{ type: "text", text: "first prompt" }],
				},
				{ type: "agentMessage", text: "first reply" },
			],
		},
		"turn-second": {
			id: "turn-second",
			status: "completed",
			items: [
				{
					type: "userMessage",
					content: [{ type: "text", text: "second prompt" }],
				},
				{ type: "agentMessage", text: "second reply" },
			],
		},
	};
	return { thread: { id: threadId, turns: ids.map((id) => turns[id]) } };
}

test("verify probe history rejects reordered native turns", () => {
	expect(() =>
		verifyProbeHistory(history(["turn-second", "turn-first"]), {
			threadId,
			turns: expectedTurns,
		}),
	).toThrow("Native turn order mismatch");
});

test("verify probe history accepts valid native turn order", () => {
	expect(() =>
		verifyProbeHistory(history(["turn-first", "turn-second"]), {
			threadId,
			turns: expectedTurns,
		}),
	).not.toThrow();
});
