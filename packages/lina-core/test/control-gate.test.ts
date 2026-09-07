import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ControlFixture, digest } from "./control-fixture.ts";

describe("approval gate", () => {
	let f: ControlFixture;
	beforeEach(() => {
		f = new ControlFixture();
	});
	afterEach(() => f.close());

	it("a native dialog can use a shorter bounded approval deadline", async () => {
		const result = f.gate.authorize(
			f.tool().id,
			{},
			new AbortController().signal,
			true,
			500,
		);
		const approval = f.controls.snapshot().approvals[0];
		expect(approval?.expiresAt).toBe(f.time + 500);
		f.advance(500);
		expect((await result).allow).toBe(false);
		expect(approval && f.controls.approval(approval.id)?.state).toBe("expired");
	});

	it.each([0, -1, Number.NaN, 300001])(
		"invalid native deadline %s never creates a waiter",
		async (ttl) => {
			const result = f.gate.authorize(
				f.tool().id,
				{},
				new AbortController().signal,
				true,
				ttl,
			);
			try {
				expect(f.controls.snapshot().approvals).toHaveLength(0);
			} finally {
				f.gate.abortAll();
			}
			expect((await result).allow).toBe(false);
		},
	);

	it("withholds execution, binds sorted exact JSON, and spends approval once", async () => {
		const tool = f.tool();
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		let executions = 0;
		const result = f.gate
			.authorize(
				tool.id,
				{ z: 2, a: { password: "unchanged", b: 1 } },
				controller.signal,
				true,
			)
			.then((r) => {
				if (r.allow) executions++;
				return r;
			});
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("no pending");
		expect(executions).toBe(0);
		expect(f.controls.tool(tool.id)?.state).toBe("waiting_approval");
		expect(a.inputJson).toBe('{"a":{"b":1,"password":"unchanged"},"z":2}');
		expect(a.inputDigest).toBe(digest(a.inputJson));
		expect(f.gate.reply(a.id, a.inputDigest, "allow")).toBe(true);
		expect(await result).toEqual({ allow: true });
		expect(executions).toBe(1);
		expect(f.gate.reply(a.id, a.inputDigest, "allow")).toBe(false);
		expect(
			(await f.gate.authorize(tool.id, {}, controller.signal, false)).allow,
		).toBe(false);
		expect(f.tasks.size).toBe(0);
		expect(remove).toHaveBeenCalled();
		remove.mockRestore();
	});

	it.each(["deny", "expiry", "abort", "close", "abortAll"] as const)(
		"%s blocks execution and releases timer/listener",
		async (action) => {
			const tool = f.tool();
			const controller = new AbortController();
			const remove = spyOn(controller.signal, "removeEventListener");
			const result = f.gate.authorize(tool.id, {}, controller.signal, true);
			const a = f.controls.snapshot().approvals[0];
			if (!a) throw new Error("no pending");
			if (action === "deny") f.gate.reply(a.id, a.inputDigest, "deny");
			if (action === "expiry") f.advance(300_000);
			if (action === "abort") controller.abort();
			if (action === "close") f.gate.close();
			if (action === "abortAll") f.gate.abortAll();
			expect((await result).allow).toBe(false);
			expect(f.controls.approval(a.id)?.state).toBe(
				action === "deny"
					? "denied"
					: action === "expiry"
						? "expired"
						: "aborted",
			);
			expect(f.controls.tool(tool.id)?.state).toBe(
				action === "deny" || action === "expiry" ? "blocked" : "interrupted",
			);
			expect(f.tasks.size).toBe(0);
			expect(remove).toHaveBeenCalled();
			remove.mockRestore();
		},
	);

	it("expires at the deadline even when timer delivery is delayed", async () => {
		const result = f.gate.authorize(
			f.tool().id,
			{},
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("no pending");
		f.time = a.expiresAt;
		expect(f.gate.reply(a.id, a.inputDigest, "allow")).toBe(false);
		expect((await result).allow).toBe(false);
		expect(f.controls.approval(a.id)?.state).toBe("expired");
	});

	it("rejects stale/mismatched replies and unknown IDs without authorizing another call", async () => {
		const result = f.gate.authorize(
			f.tool().id,
			{},
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("no pending");
		expect(f.gate.reply("missing", a.inputDigest, "allow")).toBe(false);
		expect(f.gate.reply(a.id, "f".repeat(64), "allow")).toBe(false);
		expect(f.controls.approval(a.id)?.state).toBe("pending");
		f.gate.abortAll();
		expect((await result).allow).toBe(false);
	});

	it("cannot consume persisted decisions or orphan pending approvals without its waiter", async () => {
		const orphan = f.pending();
		expect(f.gate.reply(orphan.id, orphan.inputDigest, "allow")).toBe(false);
		expect(
			(
				await f.gate.authorize(
					orphan.toolRunId,
					{ a: 1 },
					new AbortController().signal,
					false,
				)
			).allow,
		).toBe(false);
		expect(f.controls.approval(orphan.id)?.state).toBe("pending");
	});

	it("blocks capacity overflow and keeps concurrently reused native IDs independent", async () => {
		const pending = Array.from({ length: 8 }, () =>
			f.gate.authorize(f.tool().id, {}, new AbortController().signal, true),
		);
		const extra = f.tool();
		expect(
			(await f.gate.authorize(extra.id, {}, new AbortController().signal, true))
				.allow,
		).toBe(false);
		expect(f.controls.tool(extra.id)?.state).toBe("blocked");
		const approvals = f.controls.snapshot().approvals;
		expect(new Set(approvals.map((a) => a.toolRunId)).size).toBe(8);
		for (const a of approvals) f.gate.reply(a.id, a.inputDigest, "deny");
		expect((await Promise.all(pending)).every((r) => !r.allow)).toBe(true);
		expect(f.tasks.size).toBe(0);
	});

	it.each(["before reply", "after reply"] as const)(
		"blocks mutation %s, preserving the historical allowance",
		async (when) => {
			const tool = f.tool();
			const input = { target: "original" };
			const result = f.gate.authorize(
				tool.id,
				input,
				new AbortController().signal,
				true,
			);
			const a = f.controls.snapshot().approvals[0];
			if (!a) throw new Error("no pending");
			if (when === "before reply") input.target = "changed";
			f.gate.reply(a.id, a.inputDigest, "allow");
			if (when === "after reply") input.target = "changed";
			expect((await result).allow).toBe(false);
			expect(f.controls.approval(a.id)?.state).toBe("allowed");
			expect(f.controls.approval(a.id)?.inputJson).toBe(
				'{"target":"original"}',
			);
			expect(f.controls.tool(tool.id)?.state).toBe("blocked");
			expect(f.tasks.size).toBe(0);
		},
	);

	it("abort immediately after allow preserves the decision and interrupts the tool", async () => {
		const tool = f.tool();
		const controller = new AbortController();
		const result = f.gate.authorize(tool.id, {}, controller.signal, true);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("no pending");
		f.gate.reply(a.id, a.inputDigest, "allow");
		controller.abort();
		expect((await result).allow).toBe(false);
		expect(f.controls.approval(a.id)?.state).toBe("allowed");
		expect(f.controls.tool(tool.id)?.state).toBe("interrupted");
	});

	it("blocks external decisions that did not pass the live waiter", async () => {
		const result = f.gate.authorize(
			f.tool().id,
			{},
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("no pending");
		f.controls.decide(a.id, a.inputDigest, "allowed");
		expect(f.gate.reply(a.id, a.inputDigest, "allow")).toBe(false);
		expect((await result).allow).toBe(false);
		expect(f.controls.tool(a.toolRunId)?.state).toBe("blocked");
	});

	it("tracks safe calls as ready without approval, and still checks signal and JSON", async () => {
		const a = f.tool();
		const controller = new AbortController();
		expect(
			await f.gate.authorize(a.id, { a: 1 }, controller.signal, false),
		).toEqual({ allow: true });
		expect(f.controls.tool(a.id)?.state).toBe("ready");
		expect(f.controls.snapshot().approvals).toHaveLength(0);
		controller.abort();
		const b = f.tool();
		expect(
			(await f.gate.authorize(b.id, {}, controller.signal, false)).allow,
		).toBe(false);
		expect(f.controls.tool(b.id)?.state).toBe("interrupted");
		const c = f.tool();
		expect(
			(
				await f.gate.authorize(
					c.id,
					undefined,
					new AbortController().signal,
					false,
				)
			).allow,
		).toBe(false);
		expect(f.controls.tool(c.id)?.state).toBe("blocked");
	});

	it("rejects authorization when closed or tool/signal is missing", async () => {
		expect(
			(
				await f.gate.authorize(
					"unknown",
					{},
					new AbortController().signal,
					true,
				)
			).allow,
		).toBe(false);
		const a = f.tool();
		expect(
			(
				await f.gate.authorize(
					a.id,
					{},
					undefined as unknown as AbortSignal,
					true,
				)
			).allow,
		).toBe(false);
		f.gate.close();
		expect(
			(
				await f.gate.authorize(
					f.tool().id,
					{},
					new AbortController().signal,
					false,
				)
			).allow,
		).toBe(false);
	});
});
