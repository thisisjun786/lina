import { createHash } from "node:crypto";
import { id, integer, MAX_WORLD_BYTES } from "./validation.ts";

export const MAX_LIFE_ITEMS = 4096;
const MAX_JSON_DEPTH = 32;
export function finite(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		Math.abs(value) > Number.MAX_SAFE_INTEGER
	)
		throw Error("Invalid LIFE number");
	return value === 0 ? 0 : value;
}
export function revision(value: unknown, min = 0): number {
	integer(value, "LIFE revision", min);
	return value === 0 ? 0 : value;
}
export function identifier(value: unknown): string {
	id(value);
	return value;
}
export function enumeration<const T extends string>(
	value: unknown,
	allowed: readonly T[],
): T {
	if (typeof value !== "string" || !allowed.includes(value as T))
		throw Error("Invalid LIFE enum");
	return value as T;
}
export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > MAX_LIFE_ITEMS)
		throw Error("Invalid LIFE list capacity");
	return Array.from(value, parse);
}
export function keyed<T>(
	items: T[],
	key: (item: T) => string,
	sort = true,
): T[] {
	const seen = new Set<string>();
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) throw Error("Duplicate LIFE key");
		seen.add(k);
	}
	return sort
		? items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
		: items;
}
export function identifiers(value: unknown): string[] {
	return keyed(array(value, identifier), (x) => x);
}
export function flag(value: unknown): boolean {
	if (typeof value !== "boolean") throw Error("Invalid LIFE boolean");
	return value;
}
export function nullableId(value: unknown): string | null {
	return value === null ? null : identifier(value);
}
export function eventReference(value: unknown): string {
	if (typeof value !== "string") throw Error("Invalid LIFE event reference");
	const parts = value.split(":");
	identifier(parts[0]);
	if (parts.length !== 2 || !/^[1-9][0-9]*$/.test(parts[1] ?? ""))
		throw Error("Invalid LIFE event reference");
	revision(Number(parts[1]), 1);
	return value;
}
export function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw Error("Invalid LIFE digest");
	return value;
}
/** Strict JSON data only; rejects executable accessors, cycles, holes and lossy numbers. */
function encodeLifeJson(value: unknown, emit: boolean): string {
	const ancestors = new Set<object>();
	const chunks: string[] | undefined = emit ? [] : undefined;
	let bytes = 0;
	function ascii(encoded: string): void {
		chunks?.push(encoded);
		bytes += encoded.length;
	}
	function string(value: string, leaf: boolean): void {
		if (!/[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(value)) {
			const size = value.length + 2;
			if (leaf && size > MAX_WORLD_BYTES)
				throw Error("LIFE storage capacity exceeded");
			if (emit) chunks?.push(`"${value}"`);
			bytes += size;
			return;
		}
		const encoded = JSON.stringify(value);
		const size = Buffer.byteLength(encoded);
		if (leaf && size > MAX_WORLD_BYTES)
			throw Error("LIFE storage capacity exceeded");
		chunks?.push(encoded);
		bytes += size;
	}
	function encode(item: unknown, depth: number): void {
		if (depth > MAX_JSON_DEPTH) throw Error("LIFE JSON depth exceeded");
		if (item === null) {
			ascii("null");
			return;
		}
		if (typeof item === "number") {
			ascii(String(finite(item)));
			return;
		}
		if (typeof item === "boolean") {
			ascii(item ? "true" : "false");
			return;
		}
		if (typeof item === "string") {
			string(item, true);
			return;
		}
		if (!item || typeof item !== "object" || ancestors.has(item))
			throw Error("Invalid LIFE JSON");
		const list = Array.isArray(item);
		if (
			Object.getPrototypeOf(item) !==
			(list ? Array.prototype : Object.prototype)
		)
			throw Error("Invalid LIFE JSON object");
		const keys = Reflect.ownKeys(item);
		const values = new Map<string, unknown>();
		// Scan every descriptor before children, preserving rejection precedence.
		// Descriptor values also avoid invoking a Proxy's divergent get trap.
		for (const key of keys) {
			if (typeof key !== "string") throw Error("Invalid LIFE JSON property");
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (
				!descriptor ||
				(!(list && key === "length") && !descriptor.enumerable) ||
				!Object.hasOwn(descriptor, "value")
			)
				throw Error("Invalid LIFE JSON property");
			values.set(key, descriptor.value);
		}
		ancestors.add(item);
		const start = bytes;
		if (list) {
			const length = values.get("length") as number;
			if (length > MAX_LIFE_ITEMS || keys.length !== length + 1)
				throw Error("Invalid LIFE JSON list");
			ascii("[");
			for (let index = 0; index < length; index++) {
				if (index) ascii(",");
				// A hole plus an extra own key still rejects undefined here.
				encode(values.get(String(index)), depth + 1);
			}
			ascii("]");
		} else {
			if (keys.length > MAX_LIFE_ITEMS)
				throw Error("Invalid LIFE JSON capacity");
			ascii("{");
			// All keys are enumerable strings after the scan; keep UTF-16 sorting.
			const names = (keys as string[]).sort();
			for (let index = 0; index < names.length; index++) {
				if (index) ascii(",");
				const key = names[index];
				if (key === undefined) throw Error("Invalid LIFE JSON property");
				string(key, false);
				ascii(":");
				encode(values.get(key), depth + 1);
			}
			ascii("}");
		}
		ancestors.delete(item);
		// Each subtree retains its original completion-time byte check. Counting
		// encoded leaves once avoids rescanning all ancestors or changing errors.
		if (bytes - start > MAX_WORLD_BYTES)
			throw Error("LIFE storage capacity exceeded");
	}
	encode(value, 0);
	return chunks?.join("") ?? "";
}
export function canonicalLifeJson(value: unknown): string {
	return encodeLifeJson(value, true);
}
export function lifeDigest(value: unknown): string {
	return createHash("sha256").update(canonicalLifeJson(value)).digest("hex");
}
export function jsonBoundary(value: unknown): void {
	encodeLifeJson(value, false);
}
