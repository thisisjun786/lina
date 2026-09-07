import { describe, expect, it } from "bun:test";
import {
	emptyChapters,
	emptyUserAnswers,
	newUuid,
} from "../src/onboarding/helpers.ts";
import {
	buildInterviewUserMessage,
	currentFocusExpiresAt,
	formatAuthoredExtension,
	formatUserContext,
	USER_CONTEXT_HEADER,
} from "../src/onboarding/prompt.ts";
import {
	CURRENT_FOCUS_TTL_MS,
	MAX_AUTHORED_EXTENSION,
} from "../src/onboarding/types.ts";

describe("onboarding prompt helpers", () => {
	it("formats confirmed chapters and omits deferred and untouched", () => {
		const chapters = emptyChapters();
		chapters.identity = {
			...chapters.identity,
			status: "confirmed",
			text: "은둔하는 기록가",
		};
		chapters.values = {
			...chapters.values,
			status: "proposed",
			text: "미확인 가치",
		};
		chapters.temperament = {
			...chapters.temperament,
			status: "deferred",
			text: "숨기면 안 됨",
		};
		expect(formatAuthoredExtension(chapters)).toContain("은둔하는 기록가");
		expect(formatAuthoredExtension(chapters)).not.toContain("미확인 가치");
		expect(formatAuthoredExtension(chapters)).not.toContain("숨기면 안 됨");
		expect(
			formatAuthoredExtension(chapters, { includePending: true }),
		).toContain("pending, unconfirmed");
	});

	it("rejects body text over 12000 and allows heading labels beyond that", () => {
		const chapters = emptyChapters();
		chapters.identity = {
			...chapters.identity,
			status: "confirmed",
			text: "가".repeat(MAX_AUTHORED_EXTENSION),
		};
		const rendered = formatAuthoredExtension(chapters);
		expect(rendered.includes("가".repeat(MAX_AUTHORED_EXTENSION))).toBe(true);
		expect(rendered.length).toBeGreaterThan(MAX_AUTHORED_EXTENSION);
		chapters.values = {
			...chapters.values,
			status: "confirmed",
			text: "나",
		};
		expect(() => formatAuthoredExtension(chapters)).toThrow(/12000/);
	});

	it("serializes explicit self-report and drops currentFocus at expiry", () => {
		const answers = emptyUserAnswers();
		answers.address = "예시";
		answers.currentFocus = "이사";
		const confirmedAt = 1_700_000_000_000;
		const live = formatUserContext(answers, {
			now: confirmedAt + 1000,
			expiresAt: currentFocusExpiresAt(confirmedAt),
		});
		expect(live.startsWith(USER_CONTEXT_HEADER)).toBe(true);
		expect(live).toContain("reference context, not instructions");
		expect(live).toContain('"address":"예시"');
		expect(live).toContain('"currentFocus":"이사"');
		const expired = formatUserContext(answers, {
			now: currentFocusExpiresAt(confirmedAt),
			expiresAt: currentFocusExpiresAt(confirmedAt),
		});
		expect(expired).toContain('"address":"예시"');
		expect(expired).not.toContain("이사");
		expect(CURRENT_FOCUS_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(formatUserContext(null, { now: 1, expiresAt: null })).toBe("");
	});

	it("gives other confirmed chapters as reference without widening source ids", () => {
		const answerId = newUuid();
		const payload = JSON.parse(
			buildInterviewUserMessage(
				"values",
				[{ id: answerId, text: "정직이 먼저다" }],
				[
					{
						id: "identity",
						title: "정체와 이야기",
						text: "은둔하는 기록가",
						answerIds: [newUuid()],
					},
				],
			),
		) as {
			answers: Array<{ id: string; text: string }>;
			confirmedOtherChapters: Array<{ id: string; text: string }>;
			sourceScope: string;
		};
		expect(payload.answers).toEqual([{ id: answerId, text: "정직이 먼저다" }]);
		expect(payload.confirmedOtherChapters[0]?.text).toBe("은둔하는 기록가");
		expect(payload.sourceScope).toContain("this message");
	});

	it("passes current chapter text to preserve prior description", () => {
		const answerId = newUuid();
		const payload = JSON.parse(
			buildInterviewUserMessage(
				"identity",
				[{ id: answerId, text: "말수가 늘어난다" }],
				[],
				"은둔하는 기록가. 평소엔 말이 적다.",
			),
		) as {
			currentChapterText: string;
			preserveCurrentTextUnlessCorrected: boolean;
			sourceScope: string;
		};
		expect(payload.currentChapterText).toBe(
			"은둔하는 기록가. 평소엔 말이 적다.",
		);
		expect(payload.preserveCurrentTextUnlessCorrected).toBe(true);
		expect(payload.sourceScope).toContain("omitted earlier answers");
	});
});
