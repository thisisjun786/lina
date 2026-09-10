import { canonicalLifeJson } from "../../lina-core/src/world/life-json.ts";
import { authorRecord } from "./author-native-policy.ts";
import { lifeInteger } from "./life-model-validation.ts";

export const PROBE_MAX_WIRE_BYTES = 1048576;

export const PROBE_REQUEST_OPTIONS = Object.freeze({
	reasoning: Object.freeze({ effort: "none" }),
	store: false,
	parallel_tool_calls: false,
	include: Object.freeze(["reasoning.encrypted_content"]),
});

export function verifyProbeUsage(usage: unknown): void {
	if (usage === null) return;
	const counts = authorRecord(usage);
	const input = lifeInteger(counts["input_tokens"]);
	const output = lifeInteger(counts["output_tokens"]);
	const total = lifeInteger(counts["total_tokens"]);
	if (!Number.isSafeInteger(input + output) || total !== input + output)
		throw Error("Inconsistent provider usage");
	if (output > 4096) throw Error("Provider output token limit exceeded");
}

export type ProbeCapture = {
	input: unknown[];
	output: unknown[];
	text: string;
	usage: unknown;
};

/** Keep ordered content and opaque reasoning; omit only transport identity/status metadata. */
export function probeWireItems(raw: unknown): Record<string, unknown>[] {
	if (!Array.isArray(raw)) throw Error("Missing wire items");
	return raw.map((value) => {
		const item = authorRecord(value);
		if (item["type"] === "reasoning") {
			return {
				type: "reasoning",
				summary: item["summary"] ?? [],
				content: item["content"] ?? null,
				encrypted_content: item["encrypted_content"] ?? null,
			};
		}
		const role = item["role"];
		if (
			(item["type"] != null && item["type"] !== "message") ||
			!["user", "assistant", "developer"].includes(String(role)) ||
			!Array.isArray(item["content"]) ||
			!item["content"].length
		)
			throw Error("Invalid wire message");
		const content = item["content"].map((rawPart) => {
			const part = authorRecord(rawPart);
			if (
				part["type"] !==
					(role === "assistant" ? "output_text" : "input_text") ||
				typeof part["text"] !== "string"
			)
				throw Error("Non-text wire message");
			return { type: part["type"], text: part["text"] };
		});
		return { type: "message", role, phase: item["phase"] ?? null, content };
	});
}

export function probeProviderText(output: unknown[]): string {
	const messages = probeWireItems(output).filter(
		(item) => item["type"] === "message",
	);
	if (!messages.length || messages.some((item) => item["role"] !== "assistant"))
		throw Error("Missing provider assistant output");
	const texts = messages.map((item) =>
		(item["content"] as Array<{ text: string }>)
			.map((part) => part.text)
			.join(""),
	);
	if (texts.some((text) => !text)) throw Error("Empty provider output");
	return texts.join("\n");
}

/** Assert the prior admitted input plus provider output as an unchanged ordered prefix. */
export function verifyProbeWire(
	input: unknown[],
	current: string,
	previous: ProbeCapture | null,
): void {
	const items = probeWireItems(input);
	const prefix = previous
		? [...probeWireItems(previous.input), ...probeWireItems(previous.output)]
		: [];
	if (
		canonicalLifeJson(items.slice(0, prefix.length)) !==
		canonicalLifeJson(prefix)
	)
		throw Error("Prior wire history mismatch");
	const tail = items.slice(prefix.length);
	const last = tail.pop();
	if (
		!last ||
		last["role"] !== "user" ||
		canonicalLifeJson(last["content"]) !==
			canonicalLifeJson([{ type: "input_text", text: current }])
	)
		throw Error("Current wire input mismatch");
	if (tail.length > 3) throw Error("Unexpected native context");
	for (const item of tail) {
		const content = item["content"] as Array<{ text: string }> | undefined;
		const text = content?.[0]?.text;
		const tag =
			item["role"] === "user"
				? "environment_context"
				: item["role"] === "developer" &&
						text?.startsWith("<permissions instructions>")
					? "permissions instructions"
					: "skills_instructions";
		if (
			item["type"] !== "message" ||
			!["user", "developer"].includes(String(item["role"])) ||
			content?.length !== 1 ||
			!text?.startsWith(`<${tag}>\n`) ||
			!text.endsWith(`</${tag}>`)
		)
			throw Error("Unexpected native context");
	}
}
