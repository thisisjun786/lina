// biome-ignore-all lint/complexity/useLiteralKeys: JSON evidence crosses a file boundary.
import { isDeepStrictEqual } from "node:util";
import type { EpisodeTrace } from "./harness-types.ts";
import { decodeRecord } from "./records.ts";
import { parseJson, parseProposal, parseReceipt } from "./validation.ts";

function object(
	value: unknown,
	required: string[],
	optional: string[] = [],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid trace object");
	const row = value as Record<string, unknown>;
	if (
		required.some((k) => !(k in row)) ||
		Object.keys(row).some((k) => !required.includes(k) && !optional.includes(k))
	)
		throw Error("invalid trace fields");
	return row;
}
function text(value: unknown): asserts value is string {
	if (typeof value !== "string") throw Error("invalid trace string");
}
function integer(
	value: unknown,
	max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > max
	)
		throw Error("invalid trace integer");
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 10000)
		throw Error("invalid trace list");
	return value;
}
function strings(value: unknown): string[] {
	const values = list(value);
	for (const item of values) text(item);
	return values as string[];
}
function choice(value: unknown, allowed: string[]): void {
	if (typeof value !== "string" || !allowed.includes(value))
		throw Error("invalid trace enum");
}
const statuses = [
	"rejected",
	"deferred",
	"noop",
	"answered",
	"adopted",
	"dispatched",
	"unknown",
];
export function decodeTrace(value: unknown): EpisodeTrace {
	const r = object(
		value,
		[
			"version",
			"episodeId",
			"mode",
			"status",
			"requests",
			"steps",
			"effects",
			"adoptions",
			"delivered",
			"stages",
			"bridges",
		],
		["detail"],
	);
	if (r["version"] !== 1) throw Error("unsupported trace version");
	text(r["episodeId"]);
	if (!r["episodeId"]) throw Error("missing trace identity");
	choice(r["mode"], ["baseline", "kernel", "ablation"]);
	choice(r["status"], ["complete", "incomplete", "limit"]);
	if (r["detail"] !== undefined) text(r["detail"]);
	const requests = list(r["requests"]);
	if (requests.length > 6) throw Error("trace exceeds call budget");
	for (const value of requests) {
		const q = object(value, ["stage", "input", "transport", "proposal"]);
		integer(q["stage"], 5);
		const input = object(q["input"], [
			"messages",
			"omitted",
			"rawIds",
			"adoptionIds",
		]);
		strings(input["rawIds"]);
		strings(input["adoptionIds"]);
		const omissions = object(input["omitted"], ["rawIds", "derivedIds"]);
		strings(omissions["rawIds"]);
		strings(omissions["derivedIds"]);
		const messages = list(input["messages"]);
		if (messages.length !== 2) throw Error("invalid input messages");
		let chars = 0;
		for (const [i, value] of messages.entries()) {
			const m = object(value, ["role", "content"]);
			if (m["role"] !== (i === 0 ? "system" : "user"))
				throw Error("invalid message role");
			text(m["content"]);
			chars += m["content"].length;
		}
		if (chars > 24000) throw Error("oversized recorded input");
		const t = object(
			q["transport"],
			["kind", "latencyMs"],
			["content", "model", "usage", "requestId", "reason", "status", "detail"],
		);
		if (
			typeof t["latencyMs"] !== "number" ||
			!Number.isFinite(t["latencyMs"]) ||
			t["latencyMs"] < 0
		)
			throw Error("invalid latency");
		if (t["kind"] === "ok") {
			object(
				t,
				["kind", "latencyMs", "content", "model", "usage"],
				["requestId"],
			);
			text(t["content"]);
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(t["content"]);
			} catch {
				/* Rejected non-JSON output is recorded as null. */
			}
			if (!isDeepStrictEqual(parsed, q["proposal"]))
				throw Error("recorded proposal differs from model output");

			text(t["model"]);
			if (t["requestId"] !== undefined) text(t["requestId"]);
			const u = object(t["usage"], ["prompt", "completion"]);
			integer(u["prompt"]);
			integer(u["completion"]);
		} else {
			object(t, ["kind", "latencyMs", "reason", "detail"], ["status"]);
			if (t["kind"] !== "transport-failure")
				throw Error("invalid transport kind");
			choice(t["reason"], ["timeout", "http", "network", "decode"]);
			text(t["detail"]);
			if (t["status"] !== undefined) integer(t["status"], 599);
		}
	}
	const decisions = new Set<string>();
	const adopted = new Map<string, { requestIndex: number; stage: number }>();
	const answered = new Map<string, number>();
	for (const value of list(r["steps"])) {
		const s = object(value, ["stage", "kernel", "requestIndex"]);
		integer(s["stage"], 5);
		if (s["requestIndex"] !== null) {
			integer(s["requestIndex"], requests.length - 1);
		}
		const k = object(s["kernel"], ["status", "decisionId"], ["detail"]);
		choice(k["status"], statuses);
		text(k["decisionId"]);
		decisions.add(k["decisionId"]);
		if (k["status"] === "adopted") {
			if (typeof s["requestIndex"] !== "number" || adopted.has(k["decisionId"]))
				throw Error("invalid adopted request link");
			adopted.set(k["decisionId"], {
				requestIndex: s["requestIndex"],
				stage: s["stage"] as number,
			});
		}

		if (k["status"] === "answered")
			answered.set(k["decisionId"], s["stage"] as number);
		if (k["detail"] !== undefined) text(k["detail"]);
	}
	const effects = new Set<string>();
	const deliveryReceipts = new Map<
		string,
		{ bytes: unknown; audience: unknown; stage: number }
	>();
	for (const value of list(r["effects"])) {
		const e = object(value, ["effectId", "tool", "args", "receipt"]);
		text(e["effectId"]);
		text(e["tool"]);
		parseJson(e["args"]);
		const receipt = parseReceipt(e["receipt"]);
		if (receipt.effectId !== e["effectId"] || effects.has(receipt.effectId))
			throw Error("invalid effect identity");
		effects.add(receipt.effectId);
		if (e["tool"] === "@delivery" && receipt.status === "completed") {
			const payload = object(receipt.output, ["bytes", "audience", "fence"]);
			const submitted = object(e["args"], ["bytes", "audience"]);
			text(payload["fence"]);
			const stage = answered.get(payload["fence"]);
			if (
				`${payload["fence"]}:answer` !== receipt.effectId ||
				stage === undefined
			)
				throw Error("delivery has no answered decision");
			if (
				payload["bytes"] !== submitted["bytes"] ||
				payload["audience"] !== submitted["audience"]
			)
				throw Error("delivery arguments disagree with receipt");
			deliveryReceipts.set(receipt.effectId, {
				bytes: payload["bytes"],
				audience: payload["audience"],
				stage,
			});
		}
	}
	const adoptionIds = new Set<string>();
	for (const value of list(r["adoptions"])) {
		const a = object(value, [
			"id",
			"revision",
			"subject",
			"domain",
			"visibility",
			"kind",
			"text",
			"refs",
			"condition",
			"status",
			"sourceDecisionId",
		]);
		decodeRecord("adoption", a["id"], a["revision"], JSON.stringify(a));
		if (!decisions.has(String(a["sourceDecisionId"])))
			throw Error("adoption decision absent");
		const link = adopted.get(String(a["sourceDecisionId"]));
		if (!link) throw Error("adoption has no adopted decision");
		const request = requests[
			link.requestIndex
		] as EpisodeTrace["requests"][number];
		if (
			!request ||
			request.stage !== link.stage ||
			request.transport.kind !== "ok"
		)
			throw Error("adoption request mismatch");
		const proposal = parseProposal(request.proposal);
		const body = JSON.parse(request.input.messages[1]?.content ?? "");
		if (
			proposal.kind !== "adopt" ||
			proposal.purposeRevision !== body.purpose?.revision ||
			proposal.adoptionKind !== a["kind"] ||
			proposal.text !== a["text"] ||
			proposal.condition !== a["condition"] ||
			!isDeepStrictEqual(proposal.refs, a["refs"])
		)
			throw Error("adoption differs from model proposal");
		adoptionIds.add(String(a["id"]));
	}
	for (const value of list(r["delivered"])) {
		const d = object(value, ["effectId", "bytes", "audience", "stage"]);
		text(d["effectId"]);
		text(d["bytes"]);
		choice(d["audience"], ["private", "public"]);
		integer(d["stage"], 5);
		const receipt = deliveryReceipts.get(d["effectId"]);
		if (
			!receipt ||
			receipt.bytes !== d["bytes"] ||
			receipt.audience !== d["audience"] ||
			receipt.stage !== d["stage"]
		)
			throw Error("delivery disagrees with completed owner receipt");
	}
	for (const value of list(r["stages"])) {
		const s = object(value, ["stage", "purpose", "trigger"], ["effectId"]);
		integer(s["stage"], 5);
		const p = object(s["purpose"], [
			"id",
			"revision",
			"subject",
			"text",
			"audience",
			"successCriteria",
			"active",
			"policyVersion",
		]);
		decodeRecord("purpose", p["id"], p["revision"], JSON.stringify(p));
		choice(s["trigger"], [
			"answered",
			"adopted",
			"deferred",
			"noop",
			"owner-unknown",
		]);
		if (s["effectId"] !== undefined && !effects.has(String(s["effectId"])))
			throw Error("stage effect absent");
	}
	for (const value of list(r["bridges"])) {
		const b = object(value, ["evidenceId", "effectId", "owner", "revision"]);
		text(b["evidenceId"]);
		text(b["effectId"]);
		text(b["owner"]);
		integer(b["revision"]);
		if (!effects.has(b["effectId"])) throw Error("bridge receipt absent");
	}
	for (const value of requests) {
		const q = value as { input: { adoptionIds: string[] } };
		if (q.input.adoptionIds.some((id) => !adoptionIds.has(id)))
			throw Error("input adoption absent from trace");
	}
	return structuredClone(r) as EpisodeTrace;
}
