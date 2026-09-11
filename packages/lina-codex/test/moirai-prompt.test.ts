import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Judgment,
	OUTPUT_CONTRACT,
	parseJudgment,
} from "../src/moirai-judgment.ts";
import type { MoiraiRole } from "../src/moirai-probe.ts";
import { createPromptPack } from "../src/moirai-prompt-pack.ts";

const DOC = readFileSync(
	join(
		import.meta.dir,
		"../../../docs/plans/context-engines/033_moirai_prompt_candidates.md",
	),
	"utf8",
);

function fence(index: number): string {
	const blocks = [...DOC.matchAll(/```text\n([\s\S]*?)```/g)].map(
		(match) => match[1] ?? "",
	);
	const raw = blocks[index];
	if (raw == null) throw Error(`missing 033 fence ${index}`);
	return raw.replace(/\n+$/, "");
}

const COMMON = fence(0);
const CLOTHO = fence(1);
const LACHESIS = fence(2);
const ATROPOS = fence(3);
const SYNTHESIS = fence(4);
const GENERAL = fence(5);
const NAMES = /Clotho|Lachesis|Atropos/;
const PROPOSER = ["clotho", "lachesis", "atropos"] as const;
const SOURCE_REFS = ["src-current"] as const;
const ROUND = "round-1";
const SNAPSHOT = "case-v1";
const PROPOSAL = "round-1-p1";
const PROPOSALS = ["round-1-p1", "round-1-p2", "round-1-p3"] as const;

function assemble(...parts: string[]): string {
	return parts.join("\n\n");
}

function digestOf(
	revision: string,
	instructions: Record<MoiraiRole, string>,
): string {
	return createHash("sha256")
		.update(revision)
		.update("\n")
		.update(instructions.clotho)
		.update("\n")
		.update(instructions.lachesis)
		.update("\n")
		.update(instructions.atropos)
		.update("\n")
		.update(instructions.moirai)
		.digest("hex");
}

function proposer(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		roundId: ROUND,
		snapshotId: SNAPSHOT,
		proposalId: PROPOSAL,
		status: "ready",
		understanding: "현재 요청을 이해했다.",
		candidate: {
			kind: "respond",
			content: "합성 응답입니다.",
			preconditions: [],
		},
		alternatives: [],
		support: [{ claim: "현재 근거", sourceRefs: [...SOURCE_REFS] }],
		assumptions: [],
		challenge: null,
		changeCondition: null,
		outcomeCheck: null,
		evidenceRequest: null,
		...overrides,
	};
}

function synthesis(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const { proposalId: _proposalId, ...rest } = proposer();
	return {
		...rest,
		consideredProposals: PROPOSALS.map((id, index) => ({
			proposalId: id,
			disposition: index === 0 ? "use" : "reject",
			reason: "합성 비교",
		})),
		unresolved: [],
		replyDraft: "사용자 초안",
		...overrides,
	};
}

function parseProposer(body: Record<string, unknown>): Judgment {
	return parseJudgment(JSON.stringify(body), {
		roundId: ROUND,
		snapshotId: SNAPSHOT,
		sourceRefs: SOURCE_REFS,
		proposalId: PROPOSAL,
	});
}

function parseSynthesis(body: Record<string, unknown>): Judgment {
	return parseJudgment(JSON.stringify(body), {
		roundId: ROUND,
		snapshotId: SNAPSHOT,
		sourceRefs: SOURCE_REFS,
		proposalIds: PROPOSALS,
	});
}

test("C assembles three identical COMMON+GENERAL+OUTPUT and E adds ROLE", () => {
	const c = createPromptPack("C");
	const e = createPromptPack("E");
	const shared = assemble(COMMON, GENERAL, OUTPUT_CONTRACT);
	expect(OUTPUT_CONTRACT).not.toMatch(NAMES);
	expect(c.revision).toBe("moirai-ce-v0");
	expect(e.revision).toBe(c.revision);
	for (const role of PROPOSER) {
		expect(c.instructions[role]).toBe(shared);
		expect(c.instructions[role]).not.toMatch(NAMES);
	}
	expect(c.instructions.moirai).toBe(
		assemble(COMMON, SYNTHESIS, OUTPUT_CONTRACT),
	);
	expect(c.instructions.moirai).not.toMatch(NAMES);
	expect(e.instructions.clotho).toBe(
		assemble(COMMON, GENERAL, CLOTHO, OUTPUT_CONTRACT),
	);
	expect(e.instructions.lachesis).toBe(
		assemble(COMMON, GENERAL, LACHESIS, OUTPUT_CONTRACT),
	);
	expect(e.instructions.atropos).toBe(
		assemble(COMMON, GENERAL, ATROPOS, OUTPUT_CONTRACT),
	);
	expect(e.instructions.moirai).toBe(c.instructions.moirai);
	expect(c.digest).toBe(digestOf(c.revision, c.instructions));
	expect(e.digest).toBe(digestOf(e.revision, e.instructions));
	expect(c.digest).not.toBe(e.digest);
});

test("prompt packs freeze per-call strings and keep a deterministic digest", () => {
	const first = createPromptPack("E");
	const second = createPromptPack("E");
	expect(first.digest).toBe(second.digest);
	expect(first.instructions).not.toBe(second.instructions);
	expect(() => {
		(first.instructions as { clotho: string }).clotho = "mutated";
	}).toThrow();
	expect(first.instructions.clotho).toBe(second.instructions.clotho);
	expect(createPromptPack("C").digest).toBe(createPromptPack("C").digest);
});

test("parseJudgment accepts proposer and synthesis exact keys", () => {
	const ready = parseProposer(proposer());
	expect(ready.status).toBe("ready");
	if (!("proposalId" in ready)) throw Error("expected proposer judgment");
	expect(ready.proposalId).toBe(PROPOSAL);
	const need = parseProposer(
		proposer({
			status: "need_evidence",
			candidate: {
				kind: "ask_user",
				content: "확인할 정보가 있다.",
				preconditions: [],
			},
			evidenceRequest: "현재 근거가 부족하다.",
			support: [],
		}),
	);
	expect(need.status).toBe("need_evidence");
	const invalidated = parseProposer(
		proposer({
			status: "invalidated",
			understanding: "정정으로 입력이 무효다.",
			candidate: null,
			support: [],
		}),
	);
	expect(invalidated.status).toBe("invalidated");
	expect(invalidated.candidate).toBeNull();
	const aggregate = parseSynthesis(synthesis());
	expect(aggregate.status).toBe("ready");
	if (!("consideredProposals" in aggregate))
		throw Error("expected synthesis judgment");
	expect(aggregate.consideredProposals).toHaveLength(3);
});

test("malformed IDs, sourceRefs, extra keys, status and bounds are rejected", () => {
	expect(() => parseProposer(proposer({ roundId: "other" }))).toThrow();
	expect(() => parseProposer(proposer({ snapshotId: "other" }))).toThrow();
	expect(() => parseProposer(proposer({ proposalId: "round-1-p2" }))).toThrow();
	expect(() =>
		parseProposer(
			proposer({
				support: [{ claim: "없는 출처", sourceRefs: ["missing"] }],
			}),
		),
	).toThrow();
	expect(() => parseProposer(proposer({ extra: true }))).toThrow();
	expect(() =>
		parseProposer(
			proposer({
				candidate: {
					kind: "respond",
					content: "합성 응답입니다.",
					preconditions: [],
					extra: true,
				},
			}),
		),
	).toThrow();
	expect(() =>
		parseProposer(proposer({ status: "ready", evidenceRequest: "남김" })),
	).toThrow();
	expect(() =>
		parseProposer(
			proposer({
				status: "need_evidence",
				candidate: {
					kind: "respond",
					content: "합성 응답입니다.",
					preconditions: [],
				},
				evidenceRequest: "필요",
			}),
		),
	).toThrow();
	expect(() =>
		parseProposer(
			proposer({
				status: "invalidated",
				candidate: {
					kind: "respond",
					content: "합성 응답입니다.",
					preconditions: [],
				},
			}),
		),
	).toThrow();
	expect(() =>
		parseProposer(
			proposer({
				assumptions: Array.from({ length: 17 }, (_, i) => `가정 ${i + 1}`),
			}),
		),
	).toThrow();
	expect(() =>
		parseProposer(proposer({ assumptions: ["중복", "중복"] })),
	).toThrow();
	expect(() =>
		parseSynthesis(
			synthesis({ consideredProposals: undefined, proposalId: PROPOSAL }),
		),
	).toThrow();
	expect(() =>
		parseSynthesis(
			synthesis({
				consideredProposals: [
					{ proposalId: PROPOSALS[0], disposition: "use", reason: "하나" },
					{ proposalId: PROPOSALS[1], disposition: "reject", reason: "둘" },
					{ proposalId: PROPOSALS[1], disposition: "reject", reason: "셋" },
				],
			}),
		),
	).toThrow();
	expect(() =>
		parseJudgment(`\`\`\`json\n${JSON.stringify(proposer())}\n\`\`\``, {
			roundId: ROUND,
			snapshotId: SNAPSHOT,
			sourceRefs: SOURCE_REFS,
			proposalId: PROPOSAL,
		}),
	).toThrow();
	expect(() =>
		parseJudgment(`${JSON.stringify(proposer())}\n`, {
			roundId: ROUND,
			snapshotId: SNAPSHOT,
			sourceRefs: SOURCE_REFS,
			proposalId: PROPOSAL,
		}),
	).toThrow();
});

test("schema-valid invalidated judgments are returned for the caller to withhold", () => {
	const result = parseSynthesis(
		synthesis({
			status: "invalidated",
			understanding: "권한이 바뀌어 종합할 수 없다.",
			candidate: null,
			replyDraft: null,
			support: [],
		}),
	);
	expect(result.status).toBe("invalidated");
	if (!("replyDraft" in result)) throw Error("expected synthesis judgment");
	expect(result.replyDraft).toBeNull();
});
