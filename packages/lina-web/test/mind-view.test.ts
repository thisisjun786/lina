import { describe, expect, it } from "bun:test";
import type { EngineRecord } from "../../lina-memory/src/engine/types.ts";
import {
	createMindView,
	type MindResponse,
	recordPresentation,
} from "../../lina-ui/client/mind-view.ts";

const available: MindResponse = {
	available: true,
	state: {
		agentId: "alpha",
		revision: 2,
		asOf: 123,
		records: [],
		truncated: false,
	},
	processing: { error: null },
};

describe("mind view client contract", () => {
	it("reads without opening a room and sends revisioned logical retractions", async () => {
		const calls: Array<[string, string, unknown]> = [];
		const view = createMindView(async (path, method, body) => {
			calls.push([path, method ?? "GET", body]);
			return available;
		});
		expect(await view.load("alpha")).toEqual(available);
		expect(await view.retract("alpha", "record-1", 2)).toEqual(available);
		expect(calls[0]?.[0]).toBe("/api/agents/alpha/mind");
		expect(calls[1]).toEqual([
			"/api/agents/alpha/mind/retract",
			"POST",
			{ id: "record-1", revision: 2 },
		]);
	});

	it("returns room-not-open as an honest unavailable state", async () => {
		const value: MindResponse = { available: false, reason: "room-not-open" };
		const view = createMindView(async () => value);
		expect(await view.load("closed")).toEqual(value);
	});
});

it("labels provisional and retracted domain records and disables further use-stop", () => {
	const record: EngineRecord = {
		id: "r1",
		agentId: "alpha",
		subject: "relationship",
		kind: "concern",
		key: "work",
		text: "deadline",
		evidence: "inferred",
		sources: [{ entryId: "e1", quote: "deadline" }],
		status: "retracted",
		support: "provisional",
		generation: 1,
		revision: 2,
		createdAt: 1,
		updatedAt: 2,
		validFrom: 1,
		expiresAt: null,
		invalidatedAt: 2,
	};
	expect(
		recordPresentation(
			{ ...record, status: "active", kind: "mood", expiresAt: 10 },
			20,
		).status,
	).toBe("만료됨");
	expect(recordPresentation(record)).toMatchObject({
		support: "임시 추론",
		status: "사용 중지됨",
		canRetract: false,
	});
});
it("discards a retraction response after closing or switching agents", async () => {
	const pending = Promise.withResolvers<unknown>();
	const view = createMindView(async (_path, method) =>
		method === "GET" ? available : pending.promise,
	);
	await view.load("alpha");
	const retract = view.retract("alpha", "r1", 2);
	view.close();
	pending.resolve(available);
	expect(await retract).toBeUndefined();
});

it("distinguishes changed, unchanged and historical failures without claiming records from receipts", async () => {
	const { processingPresentation } = await import(
		"../../lina-ui/client/mind-view.ts"
	);
	const text = processingPresentation({
		error: null,
		pending: 2,
		sending: 1,
		changed: 0,
		unchanged: 4,
		retrying: 3,
		failed: 30,
		storedRecords: 0,
	});
	expect(text).toContain("변경 없음 4");
	expect(text).toContain("저장된 기억 0");
	expect(text).toContain("재시도 중 3");
	expect(text).toContain("실패 30");
	expect(text).not.toContain("엔진 오류");
});
