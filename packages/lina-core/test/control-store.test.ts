import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type ToolState } from "../src/control/index.ts";
import { ControlFixture, digest } from "./control-fixture.ts";

describe("control store", () => {
	let f: ControlFixture;
	beforeEach(() => {
		f = new ControlFixture();
	});
	afterEach(() => f.close());

	it("persists separate app identities and exact input across reopen", () => {
		const a = f.tool();
		const b = f.tool();
		expect(a.id).not.toBe(b.id);
		expect(a.id).not.toBe(a.nativeCallId);
		expect(a.state).toBe("preparing");
		const approval = f.pending(
			a.id,
			'{"password":"actual-secret","z":[1,true,null]}',
		);
		const snapshot = f.controls.snapshot();
		f.controls.close();
		const reopened = f.keep(
			new ControlStore(f.controlFile, f.binding, { now: f.now }),
		);
		expect(reopened.snapshot()).toEqual(snapshot);
		expect(reopened.approval(approval.id)?.inputJson).toBe(approval.inputJson);
		expect(reopened.tool("missing")).toBeUndefined();
		expect(reopened.approval("missing")).toBeUndefined();
	});

	it("bounds previews and snapshots while preserving runtime cancellation authority", () => {
		for (let i = 0; i < 50; i++) f.tool(`native-${i}`, `r${i}`);
		const a = f.controls.createTool({
			nativeCallId: "n",
			requestId: "r50",
			name: "op",
			inputPreview: "x".repeat(3000),
		});
		f.controls.setTool(a.id, "ready", "y".repeat(3000));
		const state = f.controls.snapshot({
			cancelling: true,
			cancelRequestId: "r0",
		});
		expect(state.tools).toHaveLength(40);
		expect(state.tools.find((t) => t.id === a.id)?.inputPreview).toHaveLength(
			2048,
		);
		expect(state.tools.find((t) => t.id === a.id)?.outputPreview).toHaveLength(
			2048,
		);
		expect(state).toMatchObject({
			sessionId: f.binding.sessionId,
			cancelling: true,
			cancelRequestId: "r0",
		});
		expect(f.controls.snapshot()).toMatchObject({
			cancelling: false,
			cancelRequestId: null,
			revision: state.revision,
		});
	});

	it.each([
		["allowed", "ready"],
		["denied", "blocked"],
		["expired", "blocked"],
		["aborted", "interrupted"],
	] as const)("atomically applies %s to %s", (decision, toolState) => {
		const a = f.pending();
		const revision = f.controls.snapshot().revision;
		expect(f.controls.decide(a.id, a.inputDigest, decision).state).toBe(
			decision,
		);
		expect(f.controls.tool(a.toolRunId)?.state).toBe(toolState);
		expect(f.controls.snapshot().revision).toBe(revision + 1);
		expect(() => f.controls.decide(a.id, a.inputDigest, "allowed")).toThrow();
	});

	it("rejects wrong digests, missing decisions and late allowance without changing either row", () => {
		const a = f.pending();
		const before = f.controls.snapshot();
		expect(() => f.controls.decide(a.id, "0".repeat(64), "allowed")).toThrow();
		expect(() =>
			f.controls.decide("missing", a.inputDigest, "allowed"),
		).toThrow();
		f.time = a.expiresAt;
		expect(() => f.controls.decide(a.id, a.inputDigest, "allowed")).toThrow();
		expect(f.controls.snapshot()).toEqual(before);
	});

	it("rolls back approval insertion when the tool cannot enter waiting", () => {
		const a = f.tool();
		f.controls.setTool(a.id, "blocked");
		const before = f.controls.snapshot();
		expect(() => f.pending(a.id)).toThrow();
		expect(f.controls.snapshot()).toEqual(before);
	});

	it("caps pending at eight and returns eight recent decisions separately", () => {
		for (let i = 0; i < 12; i++) {
			const a = f.pending();
			f.controls.decide(a.id, a.inputDigest, "denied");
		}
		for (let i = 0; i < 8; i++) f.pending();
		const extra = f.tool();
		const before = f.controls.snapshot();
		expect(() => f.pending(extra.id)).toThrow();
		expect(f.controls.tool(extra.id)?.state).toBe("preparing");
		expect(f.controls.snapshot()).toEqual(before);
		expect(before.approvals.filter((a) => a.state === "pending")).toHaveLength(
			8,
		);
		expect(before.approvals.filter((a) => a.state !== "pending")).toHaveLength(
			8,
		);
	});

	it("keeps the operation behind a pending approval visible after newer tools fill the window", () => {
		const pending = f.pending();
		for (let i = 0; i < 55; i++) f.tool(`later-${i}`, "r");
		const state = f.controls.snapshot();
		expect(state.tools).toHaveLength(40);
		expect(state.tools.some((tool) => tool.id === pending.toolRunId)).toBe(
			true,
		);
	});

	it("records native argument-validation failure without pretending approval or success", () => {
		const a = f.tool();
		expect(() => f.controls.setTool(a.id, "succeeded")).toThrow();
		expect(
			f.controls.setTool(a.id, "failed", "invalid native arguments").state,
		).toBe("failed");
	});

	it.each(["succeeded", "failed", "blocked", "interrupted"] as const)(
		"preserves terminal %s against late events and preview replacement",
		(terminal) => {
			const a = f.tool();
			f.controls.setTool(a.id, "ready");
			f.controls.setTool(a.id, terminal, "final");
			const before = f.controls.snapshot();
			for (const state of [
				"preparing",
				"waiting_approval",
				"ready",
				"running",
				"succeeded",
				"failed",
				"blocked",
				"interrupted",
			] as ToolState[]) {
				if (state !== terminal)
					expect(() => f.controls.setTool(a.id, state)).toThrow();
			}
			expect(() => f.controls.setTool(a.id, terminal, "changed")).toThrow();
			expect(f.controls.setTool(a.id, terminal).state).toBe(terminal);
			expect(f.controls.snapshot()).toEqual(before);
		},
	);

	it("permits streaming progress but rejects skipped/backward transitions and approval bypass", () => {
		const a = f.tool();
		expect(() => f.controls.setTool(a.id, "running")).toThrow();
		const approval = f.pending(a.id);
		expect(() => f.controls.setTool(a.id, "ready")).toThrow();
		f.controls.decide(approval.id, approval.inputDigest, "allowed");
		f.controls.setTool(a.id, "running", "partial");
		f.controls.setTool(a.id, "running", "more");
		expect(f.controls.tool(a.id)?.outputPreview).toBe("more");
		expect(() => f.controls.setTool(a.id, "ready")).toThrow();
	});

	it("recovers pending approvals as expired and active tools as interrupted, idempotently", () => {
		const pending = f.pending();
		const ready = f.tool();
		const running = f.tool();
		f.controls.setTool(ready.id, "ready");
		f.controls.setTool(running.id, "ready");
		f.controls.setTool(running.id, "running");
		const done = f.tool();
		f.controls.setTool(done.id, "blocked");
		expect(f.controls.recover()).toBeGreaterThan(0);
		expect(f.controls.approval(pending.id)?.state).toBe("expired");
		expect(f.controls.tool(pending.toolRunId)?.state).toBe("blocked");
		for (const a of [ready, running])
			expect(f.controls.tool(a.id)?.state).toBe("interrupted");
		expect(f.controls.tool(done.id)?.state).toBe("blocked");
		const revision = f.controls.snapshot().revision;
		expect(f.controls.recover()).toBe(0);
		expect(f.controls.snapshot().revision).toBe(revision);
	});

	it("checks exact JSON, digest and size at the durable authority boundary", () => {
		for (const json of ['{"a":', `"${"x".repeat(65535)}"`, '{"a":1,"a":2}']) {
			expect(() => f.pending(f.tool().id, json)).toThrow();
		}
		const a = f.tool();
		expect(() =>
			f.controls.createApproval({
				toolRunId: a.id,
				inputJson: '{"a":1}',
				inputDigest: digest('{"a":2}'),
				expiresAt: f.time + 1,
			}),
		).toThrow();
		const json = `"${"x".repeat(65534)}"`;
		expect(f.pending(a.id, json).inputJson.length).toBe(65536);
	});

	it("rolls back a decision if its tool update fails inside SQLite", () => {
		const a = f.pending();
		const before = f.controls.snapshot();
		const db = new DatabaseSync(f.controlFile);
		db.exec(
			"CREATE TRIGGER stop_update BEFORE UPDATE ON tools BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
		);
		try {
			expect(() => f.controls.decide(a.id, a.inputDigest, "allowed")).toThrow();
			expect(f.controls.snapshot()).toEqual(before);
		} finally {
			db.exec("DROP TRIGGER stop_update");
			db.close();
		}
	});
});
