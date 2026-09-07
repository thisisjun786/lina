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
export function canonicalLifeJson(value: unknown): string {
	const ancestors = new Set<object>();
	function encode(item: unknown, depth: number): string {
		if (depth > MAX_JSON_DEPTH) throw Error("LIFE JSON depth exceeded");
		if (item === null) return "null";
		if (typeof item === "number") return JSON.stringify(finite(item));
		if (typeof item === "string" || typeof item === "boolean") {
			const encoded = JSON.stringify(item);
			if (Buffer.byteLength(encoded) > MAX_WORLD_BYTES)
				throw Error("LIFE storage capacity exceeded");
			return encoded;
		}
		if (!item || typeof item !== "object" || ancestors.has(item))
			throw Error("Invalid LIFE JSON");
		if (
			Object.getPrototypeOf(item) !==
			(Array.isArray(item) ? Array.prototype : Object.prototype)
		)
			throw Error("Invalid LIFE JSON object");
		const keys = Reflect.ownKeys(item);
		if (
			keys.some(
				(key) =>
					typeof key !== "string" ||
					(!(Array.isArray(item) && key === "length") &&
						!Object.getOwnPropertyDescriptor(item, key)?.enumerable) ||
					!Object.hasOwn(
						Object.getOwnPropertyDescriptor(item, key) ?? {},
						"value",
					),
			)
		)
			throw Error("Invalid LIFE JSON property");
		ancestors.add(item);
		let result: string;
		if (Array.isArray(item)) {
			if (item.length > MAX_LIFE_ITEMS || keys.length !== item.length + 1)
				throw Error("Invalid LIFE JSON list");
			result = `[${Array.from(item, (child) => encode(child, depth + 1)).join(",")}]`;
		} else {
			if (keys.length > MAX_LIFE_ITEMS)
				throw Error("Invalid LIFE JSON capacity");
			result = `{${Object.keys(item)
				.sort()
				.map(
					(key) =>
						`${JSON.stringify(key)}:${encode(Reflect.get(item, key), depth + 1)}`,
				)
				.join(",")}}`;
		}
		ancestors.delete(item);
		if (Buffer.byteLength(result) > MAX_WORLD_BYTES)
			throw Error("LIFE storage capacity exceeded");
		return result;
	}
	return encode(value, 0);
}
export function lifeDigest(value: unknown): string {
	return createHash("sha256").update(canonicalLifeJson(value)).digest("hex");
}
export function jsonBoundary(value: unknown): void {
	canonicalLifeJson(value);
}
