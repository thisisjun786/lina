import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ControlFixture } from "./control-fixture.ts";

describe("approval JSON authority", () => {
	let f: ControlFixture;
	beforeEach(() => {
		f = new ControlFixture();
	});
	afterEach(() => f.close());

	it.each([
		undefined,
		NaN,
		Infinity,
		-Infinity,
		1n,
		Symbol("x"),
		() => 1,
		new Date(),
		new Map(),
		/x/,
		{ a: undefined },
		[undefined],
		Array(2),
		{
			toJSON() {
				return {};
			},
		},
		"x".repeat(65536),
	])("rejects non-JSON or oversized input %#", async (input) => {
		const a = f.tool();
		expect(
			(await f.gate.authorize(a.id, input, new AbortController().signal, false))
				.allow,
		).toBe(false);
		expect(f.controls.tool(a.id)?.state).toBe("blocked");
		expect(f.controls.snapshot().approvals).toHaveLength(0);
	});

	it("rejects circular, accessor, symbol and hidden properties without executing getters", async () => {
		let reads = 0;
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		const getter = Object.defineProperty({}, "secret", {
			enumerable: true,
			get() {
				reads++;
				return "bad";
			},
		});
		const array = [0];
		Object.defineProperty(array, "0", {
			get() {
				reads++;
				return 1;
			},
		});
		const hidden = Object.defineProperty({}, "hidden", { value: 1 });
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					reads++;
					return Object.prototype;
				},
				ownKeys() {
					reads++;
					return [];
				},
			},
		);
		for (const input of [
			cycle,
			getter,
			array,
			hidden,
			proxy,
			{ [Symbol("key")]: 1 },
			Object.create({ inherited: 1 }),
		]) {
			expect(
				(
					await f.gate.authorize(
						f.tool().id,
						input,
						new AbortController().signal,
						true,
					)
				).allow,
			).toBe(false);
		}
		expect(reads).toBe(0);
		expect(f.controls.snapshot().approvals).toHaveLength(0);
	});

	it("rejects accessor mutation after approval without invoking the new getter", async () => {
		let reads = 0;
		const input = { a: 1 };
		const tool = f.tool();
		const result = f.gate.authorize(
			tool.id,
			input,
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("missing approval");
		f.gate.reply(a.id, a.inputDigest, "allow");
		Object.defineProperty(input, "a", {
			get() {
				reads++;
				return 1;
			},
		});
		expect((await result).allow).toBe(false);
		expect(reads).toBe(0);
		expect(f.controls.tool(tool.id)?.state).toBe("blocked");
	});

	it("preserves plain JSON, lexical numeric keys, prototype-named keys and shared references", async () => {
		const shared = { value: "한글" };
		const input = JSON.parse('{"2":2,"10":10,"__proto__":{"token":"exact"}}');
		input.a = shared;
		input.b = shared;
		const result = f.gate.authorize(
			f.tool().id,
			input,
			new AbortController().signal,
			true,
		);
		const a = f.controls.snapshot().approvals[0];
		if (!a) throw new Error("missing approval");
		expect(a.inputJson).toBe(
			'{"10":10,"2":2,"__proto__":{"token":"exact"},"a":{"value":"한글"},"b":{"value":"한글"}}',
		);
		f.gate.reply(a.id, a.inputDigest, "allow");
		expect((await result).allow).toBe(true);
	});
});
