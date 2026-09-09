// biome-ignore-all lint/complexity/useLiteralKeys: decode external JSON at its boundary.
import type { PublicCase } from "./harness-types.ts";
import { decodeRecord } from "./records.ts";
import { parseJson } from "./validation.ts";

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid public object");
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).some((key) => !keys.includes(key)) ||
		keys.some((key) => !(key in row))
	)
		throw Error("invalid public fields");
	return row;
}
function text(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value || value.length > 16384)
		throw Error("invalid public text");
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 1000)
		throw Error("invalid public list");
	return value;
}
function strings(value: unknown): void {
	for (const item of list(value)) text(item);
}
function domain(kind: string, value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") throw Error("invalid domain row");
	const row = value as Record<string, unknown>;
	decodeRecord(kind, row["id"], row["revision"], JSON.stringify(row));
	return row;
}
const toolNames = ["lookup", "calculate", "submit", "check"];
export function decodePublicCase(value: unknown): PublicCase {
	const data = object(value, [
		"version",
		"episodeId",
		"stages",
		"tools",
		"environment",
		"prelude",
	]);
	if (data["version"] !== 1) throw Error("unsupported public version");
	text(data["episodeId"]);
	const stages = list(data["stages"]);
	if (!stages.length || stages.length > 6) throw Error("invalid public stages");
	let subject: unknown;
	for (const value of stages) {
		const stage = object(value, ["purpose", "events", "advanceOn"]);
		const purpose = domain("purpose", stage["purpose"]);
		subject ??= purpose["subject"];
		if (purpose["subject"] !== subject || purpose["active"] !== true)
			throw Error("invalid stage subject");
		if (
			!["answered", "adopted", "deferred", "noop", "owner-unknown"].includes(
				String(stage["advanceOn"]),
			)
		)
			throw Error("invalid stage trigger");
		for (const value of list(stage["events"])) {
			if (!value || typeof value !== "object")
				throw Error("invalid source event");
			const kind = (value as Record<string, unknown>)["kind"];
			if (kind === "observe" || kind === "correct") {
				const event = object(value, ["kind", "evidence"]);
				domain("evidence", event["evidence"]);
			} else if (kind === "retract") {
				const event = object(value, ["kind", "actor", "id", "revision"]);
				text(event["actor"]);
				text(event["id"]);
				if (
					!Number.isSafeInteger(event["revision"]) ||
					Number(event["revision"]) < 1
				)
					throw Error("invalid retraction revision");
			} else throw Error("invalid source event kind");
		}
	}
	const seen = new Set<string>();
	for (const value of list(data["tools"])) {
		const tool = object(value, ["name", "description", "arguments"]);
		text(tool["name"]);
		text(tool["description"]);
		if (!toolNames.includes(tool["name"]) || seen.has(tool["name"]))
			throw Error("invalid tool catalog");
		seen.add(tool["name"]);
		parseJson(tool["arguments"]);
	}
	const env = object(data["environment"], [
		"lookups",
		"tasks",
		"unavailableKeys",
		"unknownTasks",
	]);
	for (const name of ["lookups", "tasks"]) {
		if (!env[name] || typeof env[name] !== "object" || Array.isArray(env[name]))
			throw Error("invalid environment map");
	}
	for (const value of Object.values(env["lookups"] as Record<string, unknown>))
		parseJson(value);
	for (const value of Object.values(env["tasks"] as Record<string, unknown>)) {
		const task = object(value, ["required", "condition", "methods"]);
		strings(task["required"]);
		text(task["condition"]);
		if (
			!task["methods"] ||
			typeof task["methods"] !== "object" ||
			Array.isArray(task["methods"])
		)
			throw Error("invalid methods");
		for (const value of Object.values(
			task["methods"] as Record<string, unknown>,
		)) {
			const method = object(value, ["condition", "omit"]);
			text(method["condition"]);
			text(method["omit"]);
		}
	}
	strings(env["unavailableKeys"]);
	strings(env["unknownTasks"]);
	for (const value of list(data["prelude"])) {
		const prelude = object(value, ["tool", "args"]);
		if (!seen.has(String(prelude["tool"])))
			throw Error("unlisted prelude tool");
		parseJson(prelude["args"]);
	}
	return structuredClone(data) as PublicCase;
}
