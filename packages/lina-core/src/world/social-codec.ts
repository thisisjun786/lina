import {
	array,
	finite,
	jsonBoundary,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import type { SocialEncodedValue } from "./social-types.ts";

// Each tagged nesting adds three JSON levels; stay inside the shared JSON boundary.
const MAX_CODEC_DEPTH = 9;
const MAX_CODEC_NODES = 16_384;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function socialDataKey(key: unknown): string {
	if (
		typeof key !== "string" ||
		!key.length ||
		key.length > 512 ||
		UNSAFE_KEYS.has(key)
	)
		throw Error("Invalid social data key");
	return key;
}

export function parseSocialEncodedValue(value: unknown): SocialEncodedValue {
	jsonBoundary(value);
	let nodes = 0;
	function parse(item: unknown, depth: number): SocialEncodedValue {
		if (
			++nodes > MAX_CODEC_NODES ||
			depth > MAX_CODEC_DEPTH ||
			!Array.isArray(item)
		)
			throw Error("Invalid social encoding capacity");
		if (item[0] === "undefined" && item.length === 1) return ["undefined"];
		if (item[0] === "value" && item.length === 2) {
			const scalar = item[1];
			if (
				scalar === null ||
				typeof scalar === "string" ||
				typeof scalar === "boolean"
			)
				return ["value", scalar];
			if (Object.is(scalar, -0)) throw Error("Lossy social number");
			return ["value", finite(scalar)];
		}
		const isArray = item[0] === "array";
		if ((!isArray && item[0] !== "object") || item.length !== (isArray ? 3 : 2))
			throw Error("Invalid social encoding tag");
		const length = isArray ? revision(item[1]) : 0;
		if (length > MAX_LIFE_ITEMS) throw Error("Invalid social array capacity");
		const seen = new Set<string>();
		const entries = array(
			item[isArray ? 2 : 1],
			(entry): [string, SocialEncodedValue] => {
				if (!Array.isArray(entry) || entry.length !== 2)
					throw Error("Invalid social property encoding");
				const key = socialDataKey(entry[0]);
				if (
					seen.has(key) ||
					(isArray &&
						(key === "length" ||
							(/^(0|[1-9][0-9]*)$/.test(key) &&
								Number(key) < 0xffffffff &&
								Number(key) >= length)))
				)
					throw Error("Invalid social property key");
				seen.add(key);
				return [key, parse(entry[1], depth + 1)];
			},
		);
		// JS enumerates integer keys first. Reject orders the inverse cannot retain.
		const keyOrder = Object.keys(Object.fromEntries(entries));
		if (entries.some(([key], index) => key !== keyOrder[index]))
			throw Error("Invalid social property order");
		return isArray ? ["array", length, entries] : ["object", entries];
	}
	return parse(value, 0);
}

export function encodeSocialValue(value: unknown): SocialEncodedValue {
	const ancestors = new Set<object>();
	let nodes = 0;
	function encode(item: unknown, depth: number): SocialEncodedValue {
		if (++nodes > MAX_CODEC_NODES || depth > MAX_CODEC_DEPTH)
			throw Error("Social encoding capacity exceeded");
		if (item === undefined) return ["undefined"];
		if (item === null || typeof item === "string" || typeof item === "boolean")
			return ["value", item];
		if (typeof item === "number") {
			if (Object.is(item, -0)) throw Error("Lossy social number");
			return ["value", finite(item)];
		}
		if (!item || typeof item !== "object" || ancestors.has(item))
			throw Error("Invalid social state value");
		const isArray = Array.isArray(item);
		if (
			Object.getPrototypeOf(item) !==
			(isArray ? Array.prototype : Object.prototype)
		)
			throw Error("Invalid social state prototype");
		if (isArray && item.length > MAX_LIFE_ITEMS)
			throw Error("Invalid social array capacity");
		ancestors.add(item);
		const entries: Array<[string, SocialEncodedValue]> = [];
		for (const key of Reflect.ownKeys(item)) {
			if (isArray && key === "length") continue;
			const name = socialDataKey(key);
			const descriptor = Object.getOwnPropertyDescriptor(item, name);
			if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
				throw Error("Invalid social state property");
			entries.push([name, encode(descriptor.value, depth + 1)]);
		}
		if (entries.length > MAX_LIFE_ITEMS)
			throw Error("Invalid social property capacity");
		ancestors.delete(item);
		return isArray ? ["array", item.length, entries] : ["object", entries];
	}
	const encoded = encode(value, 0);
	jsonBoundary(encoded);
	return encoded;
}

export function decodeSocialValue(value: SocialEncodedValue): unknown {
	function decode(item: SocialEncodedValue): unknown {
		if (item[0] === "undefined") return undefined;
		if (item[0] === "value") return item[1];
		const output = item[0] === "array" ? new Array(item[1]) : {};
		for (const [key, child] of item[0] === "array" ? item[2] : item[1])
			Object.defineProperty(output, key, {
				value: decode(child),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		return output;
	}
	return decode(parseSocialEncodedValue(value));
}
