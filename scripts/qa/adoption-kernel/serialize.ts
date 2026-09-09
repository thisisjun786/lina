// biome-ignore-all lint/complexity/useLiteralKeys: strict indexed records.
import type {
	ModeInput,
	SerializedInput,
	ToolResultEvent,
} from "./harness-types.ts";
export const SYSTEM = `Return one JSON action, no markdown. The discriminator field is "kind" (not "action"). All actions require integer purposeRevision matching purpose.revision. Actions: answer {text}; tool {tool,args}; adopt {adoptionKind:understanding|plan|intention,text,refs:[{id,revision}],condition}; defer {reason,condition}; noop {reason}. Optional judgment:{method:string|null,expectation:{kind:none}|{kind:stated,text}}. The answer text field MUST be a JSON-encoded STRING, never an object. Example shape: ${JSON.stringify({ kind: "answer", purposeRevision: 1, text: JSON.stringify({ outcome: "clarify", value: null, missing: ["field-name"], claims: [], verificationIds: [] }) })}. The decoded answer text schema is: {outcome:answer|clarify|uncertain|failure|defer,value:string|null,missing:string[],claims:[{sourceId,role:performer|observer|recipient,domain:real|fiction}],verificationIds:string[]}. Use only supplied sources and actual tool results. Never claim unknown effects succeeded. Conditions restrict reusable learning. For a learned method-condition rule, encode condition as a JSON string with exactly two nonempty string fields: {"method":"method identifier","when":"condition identifier"}. Use the identifiers from the observed source task. Omissions mean information was not supplied. Tool argument schemas are in tools. No extra action fields.`;
export function receiptText(event: ToolResultEvent): string {
	const text = JSON.stringify(event);
	if (text.length > 4096) throw Error("receipt text exceeds environment bound");
	return text;
}
export function serializeInput(input: ModeInput): SerializedInput {
	const raw: ModeInput["raw"] = [];
	const derived: ModeInput["derived"] = [];
	const omitted = { rawIds: [] as string[], derivedIds: [] as string[] };
	let rawSize = 2;
	let stopped = false;
	for (const item of [...input.raw].sort((a, b) => a.seq - b.seq)) {
		const size = JSON.stringify(item).length + 1;
		if (stopped || rawSize + size > 16000) {
			stopped = true;
			omitted.rawIds.push(item.ref.id);
		} else {
			raw.push(item);
			rawSize += size;
		}
	}
	let derivedSize = 2;
	for (const item of input.derived) {
		const size = JSON.stringify(item).length + 1;
		if (derivedSize + size > 4000) omitted["derivedIds"].push(item.id);
		else {
			derived.push(item);
			derivedSize += size;
		}
	}
	const content = JSON.stringify({
		purpose: input.purpose,
		raw,
		derived,
		tools: input.tools,
		budget: { attempt: input.attempt, maxAttempts: 6, maxOutputTokens: 4096 },
		omitted,
	});
	if (SYSTEM.length + content.length > 24000)
		throw Error("protocol input exceeds total bound");
	return {
		messages: [
			{ role: "system", content: SYSTEM },
			{ role: "user", content },
		],
		omitted,
		rawIds: raw.map((item) => item.ref.id),
		adoptionIds: derived.map((item) => item.id),
	};
}
export function stripHostMetadata(input: SerializedInput): string {
	const body = JSON.parse(input.messages[1]?.content ?? "") as Record<
		string,
		unknown
	>;
	delete body["derived"];
	const raw = body["raw"] as Record<string, unknown>[];
	const aliases = new Map<string, string>();
	for (const item of raw) {
		if (
			typeof item["owner"] === "string" &&
			item["owner"].startsWith("tool:") &&
			typeof item["sourceId"] === "string"
		) {
			const id = item["sourceId"];
			if (!aliases.has(id)) {
				const alias = `effect-${aliases.size}`;
				aliases.set(id, alias);
				if (id.endsWith(":tool") || id.endsWith(":answer"))
					aliases.set(id.slice(0, id.lastIndexOf(":")), `${alias}-decision`);
			}
		}
	}
	function normalize(value: unknown, key = ""): unknown {
		if (typeof value === "string") {
			if (
				[
					"effectId",
					"sourceId",
					"submissionId",
					"verifier",
					"fence",
					"verificationIds",
				].includes(key)
			)
				return aliases.get(value) ?? value;
			if (key === "text" || key === "bytes") {
				try {
					return JSON.stringify(normalize(JSON.parse(value)));
				} catch {
					return value;
				}
			}
			return value;
		}
		if (Array.isArray(value)) return value.map((v) => normalize(v, key));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
			);
		return value;
	}
	body["raw"] = raw.map(({ seq: _seq, ref: _ref, ...item }) => item);
	const omitted = body["omitted"] as Record<string, unknown>;
	delete omitted["derivedIds"];
	return JSON.stringify({
		system: input.messages[0]?.content,
		body: normalize(body),
	});
}
