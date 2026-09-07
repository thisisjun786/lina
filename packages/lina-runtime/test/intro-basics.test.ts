import { expect, test } from "bun:test";
import type { DialogueRoom } from "../../lina-core/src/onboarding/dialogue-types.ts";
import { unspecifiedProfile } from "../../lina-core/src/onboarding/helpers.ts";
import {
	dialoguePrompt,
	parseDialogueReply,
} from "../src/fleet/intro-prompt.ts";

const room: DialogueRoom = {
	id: crypto.randomUUID(),
	agentId: "lina",
	kind: "user",
	status: "active",
	revision: 1,
	mode: "fast",
	draftId: null,
	createdAt: 1,
	finalization: null,
	data: {
		profile: unspecifiedProfile("lina"),
		chapters: {
			identity: "",
			values: "",
			temperament: "",
			interests: "",
			relationship: "",
			expression: "",
		},
		user: {},
		summary: [],
		ready: false,
	},
};
const out = (x: Record<string, unknown> = {}) =>
	JSON.stringify({
		reply: "알겠어요. 이 정도면 준비됐어요.",
		userUpdates: [],
		profileUpdates: {},
		chapters: {},
		summary: [],
		ready: true,
		...x,
	});
test("name and basic profile coverage cannot be bypassed by model ready or turn count", () => {
	const x = parseDialogueReply(out(), room, "안녕");
	expect(x.data.ready).toBe(false);
	expect(x.reply).toMatch(/이름|호칭|불러/);
	expect(dialoguePrompt(room, 12)).toContain("address");
});
test("refusal needs current source and stays out of profile; later answer clears it", () => {
	const x = parseDialogueReply(
		out({ userSkipped: { address: "이름은 말하고 싶지 않아" } }),
		room,
		"이름은 말하고 싶지 않아",
	);
	expect(x.data.user.address).toBeUndefined();
	expect(x.data.userSkipped?.address).toBe("이름은 말하고 싶지 않아");
	expect(x.data.ready).toBe(false);
	expect(() =>
		parseDialogueReply(
			out({ userSkipped: { address: "이름은 말하고 싶지 않아" } }),
			room,
			"안녕",
		),
	).toThrow();
	const next = parseDialogueReply(
		out({
			userUpdates: [
				{ field: "address", value: "유진", quote: "유진이라고 불러줘" },
			],
		}),
		{ ...room, data: x.data },
		"유진이라고 불러줘",
	);
	expect(next.data.user.address).toBe("유진");
	expect(next.data.userSkipped?.address).toBeUndefined();
});
test("explicit completion is respected, generic or negated quote cannot skip basics", () => {
	expect(
		parseDialogueReply(
			out({ finishQuote: "여기까지만 하고 시작하자" }),
			room,
			"여기까지만 하고 시작하자",
		).data.ready,
	).toBe(true);
	expect(
		parseDialogueReply(out({ finishQuote: "유진" }), room, "유진").data.ready,
	).toBe(false);
	expect(
		parseDialogueReply(
			out({ finishQuote: "여기까지만 하고 시작하자는 뜻은 아니야" }),
			room,
			"여기까지만 하고 시작하자는 뜻은 아니야",
		).data.ready,
	).toBe(false);
	expect(() =>
		parseDialogueReply(
			out({ finishQuote: "여기까지만 하고 시작하자" }),
			room,
			"안녕",
		),
	).toThrow();
});
test("completed basics or explicit refusal permits readiness; deletion restores missing status", () => {
	const full = {
		...room,
		data: {
			...room.data,
			user: {
				address: "유진",
				context: "공방 운영",
				interests: "사진",
				communication: "짧고 구체적으로",
			},
		},
	};
	expect(parseDialogueReply(out(), full, "좋아").data.ready).toBe(true);
	const next = parseDialogueReply(
		out({
			userUpdates: [{ field: "address", value: "", quote: "호칭 지워줘" }],
		}),
		full,
		"호칭 지워줘",
	);
	expect(next.data.ready).toBe(false);
	expect(next.data.user.address).toBe("");
});

test("skipping one question does not finish the introduction", () => {
	for (const quote of [
		"이 질문은 넘어가자",
		"다음 질문으로 넘어가",
		"이 항목은 나중에",
	])
		expect(
			parseDialogueReply(out({ finishQuote: quote }), room, quote).data.ready,
		).toBe(false);
});
test("a sourced refusal clears an earlier answer but rejects a contradictory new answer", () => {
	const known = { ...room, data: { ...room.data, user: { address: "유진" } } };
	const quote = "이름은 쓰지 말고 이 질문은 건너뛸게";
	const next = parseDialogueReply(
		out({ userSkipped: { address: quote } }),
		known,
		quote,
	);
	expect(next.data.user.address).toBe("");
	expect(next.data.userSkipped?.address).toBe(quote);
	expect(known.data.user.address).toBe("유진");
	expect(() =>
		parseDialogueReply(
			out({
				userSkipped: { address: quote },
				userUpdates: [{ field: "address", value: "유진", quote }],
			}),
			known,
			quote,
		),
	).toThrow("answered basic cannot also be skipped");
});
