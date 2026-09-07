import { expect, test } from "bun:test";
import {
	bubblesFromTurns,
	decideBoot,
	parseBootQuery,
	parseChooseResult,
	parseEntry,
	parseTurn,
} from "../client/intro-model.ts";

test("first visit and resume route to onboarding, explicit agent route still opens ordinary room", () => {
	const entry = parseEntry({ firstUser: true, resume: null, legacyDrafts: [] });
	expect(decideBoot(parseBootQuery("http://localhost/"), entry)).toMatchObject({
		kind: "intro",
		intent: "user",
	});
	expect(
		decideBoot(parseBootQuery("http://localhost/?agent=lina"), {
			...entry,
			resume: { id: crypto.randomUUID(), agentId: "lina" },
		}),
	).toEqual({ kind: "normal", agentId: "lina" });
	expect(
		decideBoot(parseBootQuery("http://localhost/"), {
			...entry,
			firstUser: false,
		}),
	).toEqual({ kind: "normal", agentId: "lina" });
});
test("server navigation result stays on the selected local room", () => {
	expect(
		parseChooseResult({
			agentId: "lina",
			roomId: null,
			url: "//outside.example/",
		}).url,
	).toBe("/?agent=lina");
});
test("a restored failed turn retains original request UUID and user source for retry", () => {
	const id = crypto.randomUUID(),
		requestId = crypto.randomUUID();
	const turn = parseTurn({
		id,
		requestId,
		seq: 1,
		text: "원문 그대로",
		reply: null,
		status: "failed",
		attempts: 1,
		error: "cancelled",
		summary: [],
		createdAt: 1,
	});
	expect(bubblesFromTurns([turn])[0]?.text).toBe("원문 그대로");
	expect(turn.requestId).toBe(requestId);
	expect(turn.id).toBe(id);
});

test("entry service failure does not prevent ordinary conversation or reopen completed intake", async () => {
	const { resolveBoot } = await import("../client/intro-model.ts");
	const result = await resolveBoot(
		parseBootQuery("http://localhost/"),
		async () => {
			throw Error("onboarding offline");
		},
	);
	expect(result.decision).toEqual({ kind: "normal", agentId: "lina" });
	expect(result.notice).toBeTruthy();
	let calls = 0;
	expect(
		(
			await resolveBoot(
				parseBootQuery("http://localhost/?onboarding=user"),
				async () => {
					calls++;
					throw Error("unused");
				},
			)
		).decision,
	).toMatchObject({ kind: "normal", agentId: "lina" });
	expect(calls).toBe(1);
});

test("completed first setup ignores a saved user-onboarding URL", async () => {
	const { resolveBoot } = await import("../client/intro-model.ts");
	let calls = 0;
	const r = await resolveBoot(
		parseBootQuery("http://localhost/?onboarding=user"),
		async () => {
			calls++;
			return { firstUser: false, resume: null, legacyDrafts: [] };
		},
	);
	expect(calls).toBe(1);
	expect(r.decision).toEqual({ kind: "normal", agentId: "lina" });
});
