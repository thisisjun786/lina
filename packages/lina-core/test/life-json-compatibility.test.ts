import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	canonicalLifeJson,
	jsonBoundary,
	lifeDigest,
} from "../src/world/life-json.ts";
import states from "./fixtures/life-json-real-states.json";
import { canonicalLifeJson as reference } from "./life-json-reference-fixture.ts";

function outcome(encode: (value: unknown) => unknown, value: unknown) {
	try {
		return { value: encode(value) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
function compare(value: unknown) {
	const expected = outcome(reference, value);
	expect(outcome(canonicalLifeJson, value)).toEqual(expected);
	if ("error" in expected)
		expect(outcome(jsonBoundary, value)).toEqual(expected);
	else {
		expect(outcome(jsonBoundary, value)).toEqual({ value: undefined });
		expect(lifeDigest(value)).toBe(
			createHash("sha256").update(String(expected.value)).digest("hex"),
		);
	}
}
function nested(value: unknown, depth: number): unknown {
	let result = value;
	for (let i = 0; i < depth; i++) result = [result];
	return result;
}

test("canonical JSON retains frozen real-state bytes and digests", () => {
	for (const state of states) {
		const value: unknown = JSON.parse(state.json);
		expect(canonicalLifeJson(value)).toBe(state.json);
		expect(lifeDigest(value)).toBe(state.digest);
		compare(value);
	}
});

test("canonical JSON matches the pre-081 encoder on deterministic nested values", () => {
	const shared = { same: [1, -0, true, null] };
	const values: unknown[] = [
		null,
		true,
		false,
		-0,
		1e-7,
		1e21,
		Number.MAX_SAFE_INTEGER,
		"\ud800",
		"\udfff",
		"\u2028\u2029\n\t\u0000",
		"é😀",
		{ "10": 1, "9": 2, "1": 3, "😀": 4, "\uffff": 5 },
		{ a: shared, z: shared },
		JSON.parse('{"__proto__":{"x":1},"constructor":"ok"}'),
	];
	let seed = 173;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	function generated(depth: number): unknown {
		if (depth === 0) return values[next() % 9];
		return next() % 2
			? [generated(depth - 1), generated(depth - 1)]
			: {
					z: generated(depth - 1),
					"10": generated(depth - 1),
					a: `text-${next()}`,
				};
	}
	for (let i = 0; i < 80; i++) values.push(generated(3));
	for (const value of values) compare(value);
});

test("canonical JSON retains exact depth, item and encoded byte boundaries", () => {
	for (const value of [
		nested([], 32),
		nested(0, 33),
		nested(0, 32),
		Array(4096).fill(0),
		Array(4097).fill(0),
		Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`k${i}`, 0])),
		Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, 0])),
		"a".repeat(999998),
		"a".repeat(999999),
		["a".repeat(999996)],
		["a".repeat(999997)],
		"\ud800".repeat(166666),
		"\ud800".repeat(166667),
		{ ["k".repeat(999995)]: 0 },
		{ ["k".repeat(999996)]: 0 },
	])
		compare(value);
});

test("canonical JSON retains strict invalid-input and multi-fault precedence", () => {
	const cycle: unknown[] = [];
	cycle.push(cycle);
	const hole = Array(2);
	hole[0] = 1;
	Object.defineProperty(hole, "extra", { value: true, enumerable: true });
	const hidden = Object.defineProperty({}, "hidden", { value: 1 });
	const symbol = { [Symbol("key")]: 1 };
	const accessor = Object.defineProperty({}, "z", {
		enumerable: true,
		get() {
			throw Error("EXECUTED");
		},
	});
	const arrayAccessor = Object.defineProperty([1], "0", {
		enumerable: true,
		get() {
			throw Error("EXECUTED");
		},
	});
	const oversizedWithAccessor = Object.defineProperty(
		{ a: "a".repeat(1000001) },
		"z",
		{
			enumerable: true,
			get() {
				throw Error("EXECUTED");
			},
		},
	);
	const globalByteContrast = ["a".repeat(600000), "b".repeat(600000), accessor];
	for (const value of [
		undefined,
		[undefined],
		{ x: undefined },
		() => 1,
		1n,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		Object.create(null),
		new Date(),
		Object.create({ x: 1 }),
		symbol,
		hidden,
		cycle,
		Array(1),
		hole,
		accessor,
		arrayAccessor,
		{ nested: accessor },
		{
			toJSON() {
				throw Error("EXECUTED");
			},
		},
		oversizedWithAccessor,
		globalByteContrast,
	]) {
		compare(value);
		expect(outcome(canonicalLifeJson, value)).not.toEqual({
			error: "EXECUTED",
		});
	}
});

test("canonical JSON reads validated descriptor values from divergent Proxy traps", () => {
	const value = new Proxy(
		{ x: 1 },
		{
			get() {
				throw Error("EXECUTED");
			},
		},
	);
	expect(canonicalLifeJson(value)).toBe('{"x":1}');
	expect(outcome(jsonBoundary, value)).toEqual({ value: undefined });
	expect(outcome(reference, value)).toEqual({ error: "EXECUTED" });
});

test("ASCII fast path retains escaping for every UTF-16 code unit in strings and keys", () => {
	for (let start = 0; start < 65536; start += 256) {
		const value = String.fromCharCode(
			...Array.from({ length: 256 }, (_, i) => start + i),
		);
		compare(value);
		compare({ [value]: value });
	}
	for (const value of [
		"plain",
		"trailing\n",
		"trailing\r",
		'quote"',
		"back\\slash",
		"",
		"\u007f",
		"\ud800",
		"\udc00",
	])
		compare(value);
});
