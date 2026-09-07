import { createHash } from "node:crypto";
import { types } from "node:util";
import { CONTROL_INPUT_MAX_CHARS } from "./types.ts";

const MAX_DEPTH = 128;

/** Serialize descriptors, never property reads: getters/toJSON/proxies cannot run. */
export function canonicalInput(input: unknown): {
	json: string;
	digest: string;
} {
	const active = new Set<object>();
	let size = 0;
	const parts: string[] = [];
	function emit(part: string): void {
		size += part.length;
		if (size > CONTROL_INPUT_MAX_CHARS)
			throw new Error("approval input exceeds 65536 characters");
		parts.push(part);
	}
	function visit(value: unknown, depth: number): void {
		if (depth > MAX_DEPTH)
			throw new Error("approval input is too deeply nested");
		if (
			value === null ||
			typeof value === "boolean" ||
			typeof value === "string"
		) {
			emit(JSON.stringify(value));
			return;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			emit(JSON.stringify(value));
			return;
		}
		if (typeof value !== "object" || value === null || types.isProxy(value))
			throw new Error("approval input must be plain JSON");
		if (active.has(value)) throw new Error("circular approval input");
		const array = Array.isArray(value);
		const proto: unknown = Object.getPrototypeOf(value);
		if (
			array
				? proto !== Array.prototype
				: proto !== Object.prototype && proto !== null
		)
			throw new Error("approval input must be plain JSON");
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		for (const key of keys) {
			if (typeof key !== "string")
				throw new Error("symbol approval input property");
			const d = descriptors[key];
			if (
				!d ||
				!("value" in d) ||
				(!d.enumerable && !(array && key === "length"))
			)
				throw new Error("accessor or hidden approval input property");
		}
		active.add(value);
		emit(array ? "[" : "{");
		if (array) {
			const length: unknown = descriptors["length"]?.value;
			if (typeof length !== "number" || keys.length !== length + 1)
				throw new Error("sparse or decorated approval array");
			for (let i = 0; i < length; i++) {
				const d = descriptors[String(i)];
				if (!d) throw new Error("sparse approval array");
				if (i) emit(",");
				visit(d.value, depth + 1);
			}
		} else {
			let first = true;
			for (const key of Object.keys(descriptors).sort()) {
				if (!first) emit(",");
				first = false;
				emit(JSON.stringify(key));
				emit(":");
				visit(descriptors[key]?.value, depth + 1);
			}
		}
		emit(array ? "]" : "}");
		active.delete(value);
	}
	visit(input, 0);
	const json = parts.join("");
	return { json, digest: createHash("sha256").update(json).digest("hex") };
}

export function validateAuthority(json: string, digest: string): void {
	if (typeof json !== "string" || json.length > CONTROL_INPUT_MAX_CHARS)
		throw new Error("invalid approval input JSON");
	const canonical = canonicalInput(JSON.parse(json) as unknown);
	if (canonical.json !== json || canonical.digest !== digest)
		throw new Error("invalid approval input authority");
}
