import { expect, test } from "bun:test";
import {
	accountingFixture,
	output,
} from "./life-image-accounting-fixture.test.ts";

test("prepared reservations share event/avatar allowance and survive real reopen/window rollover", () => {
	const f = accountingFixture();
	try {
		const event = f.input(),
			avatar = f.input({ kind: "avatar" });
		f.tx(() => f.ledger.prepare(event));
		f.tx(() => f.ledger.prepare(avatar));
		f.time(9000);
		const reopened = f.connect();
		reopened.ledger.validate();
		expect(reopened.ledger.usage("world").count).toEqual({
			reserved: 2,
			consumed: 0,
			total: 2,
		});
		const third = f.input();
		expect(() =>
			f.tx(() => reopened.ledger.prepare(third), reopened.db),
		).toThrow(/allowance/);
		const other = f.input({ worldId: "other" });
		f.tx(() => reopened.ledger.prepare(other), reopened.db);
		expect(reopened.ledger.usage("other").count.total).toBe(1);
	} finally {
		f.close();
	}
});

test("dispatch time is original, HTTP rejection consumes one, and failure frees only output", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.time(1500);
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.time(1700);
		expect(() => f.tx(() => f.ledger.beforeSubmit(input.binding))).toThrow(
			/dispatch/,
		);
		f.save("preflight", input.binding.attemptId, 1, true);
		expect(() =>
			f.tx(() => f.ledger.settle(input.binding, { kind: "no_post" })),
		).toThrow(/dispatch/);
		f.tx(() => f.ledger.settle(input.binding, { kind: "failed" }));
		const reopened = f.connect();
		reopened.ledger.validate();
		expect(reopened.ledger.get(input.binding).dispatchAtMs).toBe(1500);
		expect(reopened.ledger.usage("world").count).toEqual({
			reserved: 0,
			consumed: 1,
			total: 1,
		});
		expect(reopened.ledger.usage("world").storage.outputBytes).toBe(0);
		expect(reopened.ledger.usage("world").storage.metadataBytes).toBe(16_384);
		expect(reopened.ledger.usage("world").storage.manifestBytes).toBe(8192);
		f.time(2499);
		expect(reopened.ledger.usage("world").count.consumed).toBe(1);
		f.time(2500);
		expect(reopened.ledger.usage("world").count.consumed).toBe(0);
	} finally {
		f.close();
	}
});

test("never dispatched release needs owned evidence; unknown cannot expire or refund", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		expect(() =>
			f.tx(() => f.ledger.settle(input.binding, { kind: "no_post" })),
		).toThrow(/preflight/);
		f.save("preflight", input.binding.attemptId, 1, true);
		f.tx(() => f.ledger.settle(input.binding, { kind: "no_post" }));
		expect(f.ledger.usage("world").count.total).toBe(0);
		const unknown = f.input();
		f.tx(() => f.ledger.prepare(unknown));
		f.tx(() => f.ledger.beforeSubmit(unknown.binding));
		f.tx(() => f.ledger.settle(unknown.binding, { kind: "unknown" }));
		f.time(9000);
		expect(f.ledger.usage("world").count.reserved).toBe(1);
		expect(f.ledger.usage("world").storage.outputBytes).toBe(2_097_152);
		expect(() => f.tx(() => f.ledger.abandonOutput(unknown.binding))).toThrow(
			/known result/,
		);
	} finally {
		f.close();
	}
});

test("known filename survives failed import; abandonment/reacquire and orphan adoption never resubmit", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() =>
			f.ledger.settle(input.binding, {
				kind: "result",
				resultFilename: "output.png",
			}),
		);
		f.tx(() => f.ledger.abandonOutput(input.binding));
		expect(f.ledger.usage("world").storage.outputBytes).toBe(0);
		expect(() =>
			f.tx(() =>
				f.ledger.importOutput(input.binding, output(input.binding.jobId)),
			),
		).toThrow(/reservation/);
		f.tx(() => f.ledger.reacquireOutput(input.binding));
		f.tx(() =>
			f.ledger.recordOrphan(input.binding, output(input.binding.jobId)),
		);
		const reopened = f.connect();
		reopened.ledger.validate();
		expect(reopened.ledger.usage("world").storage.outputBytes).toBe(1024);
		f.tx(
			() =>
				reopened.ledger.importOutput(
					input.binding,
					output(input.binding.jobId),
				),
			reopened.db,
		);
		f.tx(
			() =>
				reopened.ledger.importOutput(
					input.binding,
					output(input.binding.jobId),
				),
			reopened.db,
		);
		expect(reopened.ledger.usage("world").storage.assets).toBe(1);
		expect(reopened.ledger.usage("world").storage.outputBytes).toBe(1024);
		expect(reopened.ledger.usage("world").count.consumed).toBe(1);
		expect(() =>
			f.tx(
				() =>
					reopened.ledger.importOutput(input.binding, {
						...output(input.binding.jobId),
						size: 1025,
					}),
				reopened.db,
			),
		).toThrow(/conflict/);
		expect(() =>
			f.tx(() => reopened.ledger.beforeSubmit(input.binding), reopened.db),
		).toThrow(/dispatch/);
	} finally {
		f.close();
	}
});

test("last slot belongs to one real connection holding BEGIN IMMEDIATE", () => {
	const f = accountingFixture();
	try {
		f.save("config", "world", 1, {
			...f.config,
			usage: { ...f.config.usage, maxImages: 1 },
		});
		const one = f.input(),
			two = f.input({ kind: "avatar" }),
			contender = f.connect();
		f.db.exec("BEGIN IMMEDIATE");
		f.ledger.prepare(one);
		expect(() => contender.db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
		f.db.exec("COMMIT");
		expect(() =>
			f.tx(() => contender.ledger.prepare(two), contender.db),
		).toThrow(/allowance/);
		expect(contender.ledger.usage("world").count.total).toBe(1);
	} finally {
		f.close();
	}
});
