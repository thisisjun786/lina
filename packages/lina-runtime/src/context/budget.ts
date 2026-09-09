export interface ContextEstimator {
	id: string;
	kind: "heuristic" | "tokenizer" | "host";
	text(value: string): number;
	messages(value: readonly unknown[]): number;
}
function bytes(value: string): number {
	return Math.ceil(new TextEncoder().encode(value).length / 2);
}
/** A conservative byte-based heuristic; not a tokenizer or guaranteed upper bound. */
export const conservativeEstimator: ContextEstimator = Object.freeze({
	id: "utf8-half-heuristic-v1",
	kind: "heuristic",
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

export function characterPrefix(text: string, maxChars: number): string {
	let end = Math.min(text.length, maxChars);
	const last = text.charCodeAt(end - 1),
		next = text.charCodeAt(end);
	if (
		end < text.length &&
		last >= 0xd800 &&
		last <= 0xdbff &&
		next >= 0xdc00 &&
		next <= 0xdfff
	)
		end--;
	return text.slice(0, end);
}
