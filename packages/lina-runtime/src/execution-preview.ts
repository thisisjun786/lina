import { canonicalInput } from "../../lina-core/src/control/control-json.ts";

const SECRET_FIELD = /^(api_?key|token|password|secret|authorization|cookie)$/i;
export function inputPreview(input: unknown): string {
	try {
		const plain: unknown = JSON.parse(canonicalInput(input).json);
		return JSON.stringify(
			plain,
			(key, value: unknown) => (SECRET_FIELD.test(key) ? "[redacted]" : value),
			2,
		).slice(0, 2048);
	} catch {
		return "Arguments await native validation";
	}
}
export function outputPreview(result: unknown): string {
	if (
		typeof result !== "object" ||
		result === null ||
		!("content" in result) ||
		!Array.isArray(result.content)
	)
		return "";
	return result.content
		.flatMap((block: unknown) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n")
		.slice(-2048);
}
