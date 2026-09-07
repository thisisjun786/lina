import { expect, test } from "bun:test";
import { unspecifiedProfile } from "../../lina-core/src/onboarding/helpers.ts";
import {
	dialoguePrompt,
	parseDialogueReply,
} from "../src/fleet/intro-prompt.ts";

const room = {
	id: crypto.randomUUID(),
	agentId: "lina",
	kind: "user" as const,
	status: "active" as const,
	revision: 1,
	mode: "fast" as const,
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
const output = (patch: Record<string, unknown> = {}) =>
	JSON.stringify({
		reply: "반가워요. 요즘 어떤 일에 시간을 쓰세요?",
		userUpdates: [],
		profileUpdates: {},
		chapters: {},
		summary: [],
		ready: false,
		...patch,
	});
test("user updates need exact current user evidence; assistant and stale text cannot establish a fact", () => {
	const text = "저는 다온이에요. 오늘은 조금 지쳤어요.";
	const good = parseDialogueReply(
		output({
			userUpdates: [
				{ field: "address", value: "다온", quote: "저는 다온이에요." },
				{
					field: "currentFocus",
					value: "오늘은 지친 상태",
					quote: "오늘은 조금 지쳤어요.",
				},
			],
		}),
		room,
		text,
	);
	expect(good.data.user).toEqual({
		address: "다온",
		currentFocus: "오늘은 지친 상태",
	});
	expect(() =>
		parseDialogueReply(
			output({
				userUpdates: [
					{ field: "interests", value: "우주", quote: "우주가 좋아요" },
				],
			}),
			room,
			text,
		),
	).toThrow();
	expect(() =>
		parseDialogueReply(
			output({ profileUpdates: { name: "다온" } }),
			room,
			text,
		),
	).toThrow();
	expect(() =>
		parseDialogueReply(
			output({ userUpdates: [{ field: "address", value: "가짜", quote: "" }] }),
			room,
			null,
		),
	).toThrow();
});
test("sparse user correction replaces previous field and explicit removal stays blank", () => {
	const current = {
		...room,
		data: {
			...room.data,
			user: { address: "잘못된 이름", communication: "이모지 많이" },
		},
	};
	const next = parseDialogueReply(
		output({
			userUpdates: [
				{ field: "address", value: "다온", quote: "다온이라고 불러줘" },
				{ field: "communication", value: "", quote: "말투 설정은 지워줘" },
			],
		}),
		current,
		"다온이라고 불러줘. 말투 설정은 지워줘",
	);
	expect(next.data.user).toEqual({ address: "다온", communication: "" });
});
test("persona proposal remains separate from user description, forbids identity/system control fields", () => {
	const persona = { ...room, kind: "persona" as const };
	expect(
		parseDialogueReply(
			output({
				profileUpdates: { name: "세라" },
				chapters: { values: "솔직함을 지킨다" },
			}),
			persona,
			"이름은 세라. 솔직했으면 해",
		).data.profile.name,
	).toBe("세라");
	expect(() =>
		parseDialogueReply(
			output({ profileUpdates: { id: "other" } }),
			persona,
			"바꿔줘",
		),
	).toThrow();
	expect(() =>
		parseDialogueReply(
			output({
				userUpdates: [{ field: "interests", value: "우주", quote: "우주" }],
			}),
			persona,
			"우주",
		),
	).toThrow();
	expect(dialoguePrompt(persona, 3)).toContain("one question");
});
