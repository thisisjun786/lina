export type SummaryCall = (
	text: string,
	maxTokens: number,
	signal: AbortSignal,
	/** Trusted synchronous source check; not serialized into the summary prompt. */
	beforeDispatch?: () => void,
) => Promise<string>;

/** A bounded escalation path, with visible degradation and no source deletion. */
export async function summarizeBounded(
	input: string,
	call: SummaryCall,
	signal: AbortSignal,
	fits: (text: string) => boolean = () => true,
): Promise<{ text: string; kind: "model" | "extractive" }> {
	if (!input || input.length > 32_768)
		throw new Error("Summary input must be nonempty and bounded");
	const maxChars = Math.min(8192, Math.max(64, Math.floor(input.length * 0.6)));
	for (const maxTokens of [2048, 512]) {
		signal.throwIfAborted();
		try {
			const text = (await call(input, maxTokens, signal)).trim();
			signal.throwIfAborted();
			if (
				text &&
				text.length <= maxChars &&
				text.length < input.length &&
				fits(text)
			)
				return { text, kind: "model" };
		} catch {
			signal.throwIfAborted();
		}
	}
	const marker =
		"[Extractive fallback: abridged; expand sources for originals]\n";
	for (
		let size = maxChars;
		size >= marker.length;
		size = Math.floor(size / 2)
	) {
		signal.throwIfAborted();
		const text = marker + input.slice(0, size - marker.length);
		if (text.length < input.length && fits(text))
			return { text, kind: "extractive" };
	}
	throw new Error("Summary and kept context cannot fit the model budget");
}
