// biome-ignore-all lint/complexity/useLiteralKeys: untrusted records require indexed access under strict TypeScript.
import type {
	JsonValue,
	Proposal,
	Quality,
	Ref,
	ToolReceipt,
} from "./types.ts";

const MAX_TEXT = 16_384;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown, name: string): string => {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_TEXT
	)
		throw Error(`invalid ${name}`);
	return value;
};
const number = (value: unknown, name: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw Error(`invalid ${name}`);
	return value;
};
function only(value: Record<string, unknown>, keys: string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw Error("unknown proposal field");
}
export function parseRef(value: unknown): Ref {
	if (!isObject(value)) throw Error("invalid ref");
	only(value, ["id", "revision"]);
	return {
		id: string(value["id"], "ref id"),
		revision: number(value["revision"], "ref revision"),
	};
}
export function parseJson(value: unknown, depth = 0): JsonValue {
	if (
		depth > 12 ||
		value === undefined ||
		typeof value === "bigint" ||
		typeof value === "function" ||
		typeof value === "symbol"
	)
		throw Error("invalid JSON");
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw Error("invalid JSON number");
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 100) throw Error("JSON array too large");
		return value.map((item) => parseJson(item, depth + 1));
	}
	if (!isObject(value) || Object.keys(value).length > 100)
		throw Error("invalid JSON object");
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			string(key, "JSON key"),
			parseJson(item, depth + 1),
		]),
	);
}
export function parseQuality(value: unknown): Quality {
	if (!isObject(value)) throw Error("invalid quality");
	only(value, ["status", "verifier", "detail"]);
	if (
		value["status"] !== "unverified" &&
		value["status"] !== "pass" &&
		value["status"] !== "fail"
	)
		throw Error("invalid quality status");
	if (value["verifier"] !== null && typeof value["verifier"] !== "string")
		throw Error("invalid verifier");
	return {
		status: value["status"],
		verifier: value["verifier"],
		detail: string(value["detail"], "quality detail"),
	};
}
function parseAction(value: unknown): Proposal {
	if (!isObject(value) || typeof value["kind"] !== "string")
		throw Error("invalid proposal");
	const purposeRevision = number(value["purposeRevision"], "purpose revision");
	switch (value["kind"]) {
		case "answer":
			only(value, ["kind", "purposeRevision", "text"]);
			return {
				kind: "answer",
				purposeRevision,
				text: string(value["text"], "answer"),
			};
		case "adopt": {
			only(value, [
				"kind",
				"purposeRevision",
				"adoptionKind",
				"text",
				"refs",
				"condition",
			]);
			if (
				value["adoptionKind"] !== "understanding" &&
				value["adoptionKind"] !== "plan" &&
				value["adoptionKind"] !== "intention"
			)
				throw Error("invalid adoption kind");
			if (!Array.isArray(value["refs"]) || value["refs"].length > 32)
				throw Error("invalid refs");
			return {
				kind: "adopt",
				purposeRevision,
				adoptionKind: value["adoptionKind"],
				text: string(value["text"], "adoption text"),
				refs: value["refs"].map(parseRef),
				condition: string(value["condition"], "condition"),
			};
		}
		case "tool":
			only(value, ["kind", "purposeRevision", "tool", "args"]);
			return {
				kind: "tool",
				purposeRevision,
				tool: string(value["tool"], "tool"),
				args: parseJson(value["args"]),
			};
		case "defer":
			only(value, ["kind", "purposeRevision", "reason", "condition"]);
			return {
				kind: "defer",
				purposeRevision,
				reason: string(value["reason"], "reason"),
				condition: string(value["condition"], "condition"),
			};
		case "noop":
			only(value, ["kind", "purposeRevision", "reason"]);
			return {
				kind: "noop",
				purposeRevision,
				reason: string(value["reason"], "reason"),
			};
		default:
			throw Error("unknown proposal kind");
	}
}

export function parseReceipt(value: unknown): ToolReceipt {
	if (!isObject(value)) throw Error("invalid tool receipt");
	only(value, ["effectId", "status", "output", "quality"]);
	const status = value["status"];
	if (status !== "completed" && status !== "failed" && status !== "unknown")
		throw Error("invalid receipt status");
	return {
		effectId: string(value["effectId"], "effect id"),
		status,
		output: parseJson(value["output"]),
		quality: parseQuality(value["quality"]),
	};
}

export function parseJudgment(value: unknown): import("./types.ts").Judgment {
	if (!isObject(value)) throw Error("invalid judgment");
	only(value, ["method", "expectation"]);
	const method =
		value["method"] === null ? null : string(value["method"], "method");
	const exp = value["expectation"];
	if (!isObject(exp)) throw Error("invalid expectation");
	if (exp["kind"] === "none") {
		only(exp, ["kind"]);
		return { method, expectation: { kind: "none" } };
	}
	if (exp["kind"] === "stated") {
		only(exp, ["kind", "text"]);
		return {
			method,
			expectation: { kind: "stated", text: string(exp["text"], "expectation") },
		};
	}
	throw Error("invalid expectation kind");
}
export function parseProposal(value: unknown): Proposal {
	if (!isObject(value)) throw Error("invalid proposal");
	const { judgment, ...action } = value;
	const parsed = parseAction(action);
	return judgment === undefined
		? parsed
		: { ...parsed, judgment: parseJudgment(judgment) };
}
