export interface ContextEstimator {
	id: string;
	kind: "conservative" | "tokenizer" | "host";
	text(value: string): number;
	messages(value: readonly unknown[]): number;
}
function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}
/** A conservative byte estimate, never advertised as a model tokenizer. */
export const conservativeEstimator: ContextEstimator = Object.freeze({
	id: "utf8-bytes-v1",
	kind: "conservative",
	text: bytes,
	messages: (values: readonly unknown[]) => bytes(JSON.stringify(values)),
});
export function measuredTokens(
	estimator: ContextEstimator,
	text: string,
): number {
	const n = estimator.text(text);
	if (!Number.isSafeInteger(n) || n < 0)
		throw Error("Invalid context token estimate");
	return n;
}
/** Select a whole-code-point prefix including all host framing in the measurement. */
export function takeBudgetPrefix(
	text: string,
	maxTokens: number,
	estimator: ContextEstimator,
	envelope: (text: string) => string = (v) => v,
): string {
	if (!Number.isSafeInteger(maxTokens) || maxTokens < 0)
		throw Error("Invalid context token budget");
	if (measuredTokens(estimator, envelope(text)) <= maxTokens) return text;
	const offsets = [0];
	let offset = 0;
	for (const point of text) {
		offset += point.length;
		offsets.push(offset);
	}
	let low = 0,
		high = offsets.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (
			measuredTokens(estimator, envelope(text.slice(0, offsets[mid]))) <=
			maxTokens
		)
			low = mid;
		else high = mid - 1;
	}
	const end = offsets[low] ?? 0;
	if (!end && text)
		throw Error("Context budget cannot fit a source code point and framing");
	const result = text.slice(0, end);
	if (measuredTokens(estimator, envelope(result)) > maxTokens)
		throw Error("Context framing exceeds budget");
	return result;
}
