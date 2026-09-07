import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ApprovalGate } from "../src/control/index.ts";
import { ControlFixture } from "./control-fixture.ts";

describe("gate final handoff and scheduler boundaries", () => {
	let f: ControlFixture;
	beforeEach(() => {
		f = new ControlFixture();
	});
	afterEach(() => f.close());

	it("blocks an allowance that expires before the authorization continuation", async () => {
		const tool = f.tool();
		const result = f.gate.authorize(
			tool.id,
			{},
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("missing approval");
		f.time = a.expiresAt - 1;
		expect(f.gate.reply(a.id, a.inputDigest, "allow")).toBe(true);
		f.time = a.expiresAt;
		expect((await result).allow).toBe(false);
		expect(f.controls.approval(a.id)?.state).toBe("allowed");
		expect(f.controls.tool(tool.id)?.state).toBe("blocked");
	});

	it.each(["abortAll", "close"] as const)(
		"%s after reply interrupts the final handoff without rewriting allowance",
		async (action) => {
			const tool = f.tool();
			const result = f.gate.authorize(
				tool.id,
				{},
				new AbortController().signal,
				true,
			);
			const a = f.controls.snapshot().approvals[0];
			if (!a) throw new Error("missing approval");
			f.gate.reply(a.id, a.inputDigest, "allow");
			f.gate[action]();
			expect((await result).allow).toBe(false);
			expect(f.controls.approval(a.id)?.state).toBe("allowed");
			expect(f.controls.tool(tool.id)?.state).toBe("interrupted");
			expect(f.tasks.size).toBe(0);
		},
	);

	it.each(["mutate", "abort"] as const)(
		"safe calls still reject %s during final handoff",
		async (action) => {
			const tool = f.tool();
			const input = { a: 1 };
			const controller = new AbortController();
			const result = f.gate.authorize(tool.id, input, controller.signal, false);
			if (action === "mutate") input.a = 2;
			else controller.abort();
			expect((await result).allow).toBe(false);
			expect(f.controls.tool(tool.id)?.state).toBe(
				action === "mutate" ? "blocked" : "interrupted",
			);
		},
	);

	it("scheduler failure settles pending approval and removes the listener", async () => {
		const gate = f.keep(
			new ApprovalGate(f.controls, {
				now: f.now,
				schedule() {
					throw new Error("scheduler unavailable");
				},
			}),
		);
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		const tool = f.tool();
		expect(
			(await gate.authorize(tool.id, {}, controller.signal, true)).allow,
		).toBe(false);
		expect(f.controls.snapshot().approvals[0]?.state).toBe("aborted");
		expect(f.controls.tool(tool.id)?.state).toBe("interrupted");
		expect(remove).toHaveBeenCalled();
		remove.mockRestore();
	});

	it("early timer wakeups wait until the actual deadline", async () => {
		const result = f.gate.authorize(
			f.tool().id,
			{},
			new AbortController().signal,
			true,
		);
		const task = f.tasks.entries().next().value;
		if (!task) throw new Error("missing timer");
		f.tasks.delete(task[0]);
		task[1].run();
		expect(f.controls.snapshot().approvals[0]?.state).toBe("pending");
		expect(f.tasks.size).toBe(1);
		f.advance(300_000);
		expect((await result).allow).toBe(false);
		expect(f.tasks.size).toBe(0);
	});

	it("missing policy cannot silently choose the safe-tool path", async () => {
		const tool = f.tool();
		expect(
			(
				await f.gate.authorize(
					tool.id,
					{},
					new AbortController().signal,
					undefined as unknown as boolean,
				)
			).allow,
		).toBe(false);
		expect(f.controls.tool(tool.id)?.state).toBe("blocked");
	});
});
