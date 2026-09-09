// biome-ignore-all lint/complexity/useLiteralKeys: SQLite records cross a persistence boundary.
import { decodeFrame } from "./records.ts";
import type { Frame, JsonValue, ToolReceipt } from "./types.ts";
import { parseJson, parseReceipt } from "./validation.ts";

export type EffectRecord = {
	effectId: string;
	tool: string;
	args: JsonValue;
	fence: string;
	status: "dispatched" | "cancelled" | ToolReceipt["status"];
	sourceFrame: Frame;
	receipt?: ToolReceipt;
};
export function decodeEffect(id: unknown, text: unknown): EffectRecord {
	if (typeof id !== "string" || typeof text !== "string")
		throw Error("invalid stored effect");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid stored effect");
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).some(
			(key) =>
				![
					"effectId",
					"tool",
					"args",
					"fence",
					"status",
					"sourceFrame",
					"receipt",
				].includes(key),
		) ||
		data["effectId"] !== id ||
		typeof data["fence"] !== "string" ||
		!data["fence"] ||
		typeof data["tool"] !== "string" ||
		!data["tool"] ||
		!["dispatched", "cancelled", "completed", "failed", "unknown"].includes(
			String(data["status"]),
		)
	)
		throw Error("invalid stored effect");
	if (id !== `${data["fence"]}:tool` && id !== `${data["fence"]}:answer`)
		throw Error("invalid stored effect fence");
	const result: EffectRecord = {
		effectId: id,
		tool: data["tool"],
		args: parseJson(data["args"]),
		fence: data["fence"],
		status: data["status"] as EffectRecord["status"],
		sourceFrame: decodeFrame(data["sourceFrame"]),
	};
	if (data["receipt"] !== undefined) {
		const receipt = parseReceipt(data["receipt"]);
		if (receipt.effectId !== id || receipt.status !== result.status)
			throw Error("invalid stored effect receipt");
		result.receipt = receipt;
	} else if (result.status !== "dispatched" && result.status !== "cancelled")
		throw Error("missing stored effect receipt");
	return result;
}
