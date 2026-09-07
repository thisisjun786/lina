import { describe, expect, test } from "bun:test";
import {
	decodeSocialValue,
	encodeSocialValue,
	parseSocialEncodedValue,
} from "../src/world/social-codec.ts";

describe("lossless social checkpoint codec", () => {
	test("round trips undefined, sparse slots, named array metadata and key order", () => {
		const a: unknown[] = new Array(3);
		a[1] = undefined;
		Object.assign(a, { englishInfluences: [], z: true, a: { value: 2 } });
		const encoded = encodeSocialValue({ z: undefined, a });
		const decoded = decodeSocialValue(JSON.parse(JSON.stringify(encoded)));
		expect(encodeSocialValue(decoded)).toEqual(encoded);
		expect(Object.keys(decoded as object)).toEqual(["z", "a"]);
		const output = Reflect.get(decoded as object, "a");
		expect(output.length).toBe(3);
		expect(Object.hasOwn(output, 0)).toBe(false);
		expect(Object.hasOwn(output, 1)).toBe(true);
		expect(Object.keys(output)).toEqual(["1", "englishInfluences", "z", "a"]);
	});
	test("rejects lossy values and never invokes accessors", () => {
		let reads = 0;
		const input = {
			get value() {
				reads++;
				return 1;
			},
		};
		expect(() => encodeSocialValue(input)).toThrow();
		expect(reads).toBe(0);
		for (const value of [
			Number.NaN,
			Infinity,
			-0,
			1n,
			Symbol("x"),
			() => 1,
			new Date(),
		])
			expect(() => encodeSocialValue(value)).toThrow();
		const cycle: unknown[] = [];
		cycle.push(cycle);
		expect(() => encodeSocialValue(cycle)).toThrow();
	});
	test.each(
		[
			[
				"object",
				[
					["x", ["value", 1]],
					["x", ["value", 2]],
				],
			],
			["object", [["__proto__", ["object", []]]]],
			["array", 0, [["0", ["undefined"]]]],
			["array", 1, [["length", ["value", 2]]]],
			["value", {}],
			["undefined", 1],
		].map((encoded) => ({ encoded })),
	)("rejects malformed encoding %j", ({ encoded }) => {
		expect(() => parseSocialEncodedValue(encoded)).toThrow();
	});
});
