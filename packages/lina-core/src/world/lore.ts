import type { EvaluationInput, LoreEntry } from "./authoring-types.ts";
import {
	conditionPasses,
	type EvaluatedCandidate,
	type EvaluationContext,
	evaluateEffects,
	evaluateText,
} from "./rules.ts";

/** NFKC plus Unicode letters/marks/numbers; no authored regular expressions. */
function tokens(text: string): string[] {
	return (
		text
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []
	);
}
export function loreVisible(entry: LoreEntry, input: EvaluationInput): boolean {
	const policy = entry.disclosure;
	return (
		policy.knowers.includes(input.agentId) &&
		(input.recipientId === null ||
			(policy.publication.includes(input.recipientId) &&
				policy.disclosures.some(
					(d) =>
						d.agentId === input.agentId && d.recipientId === input.recipientId,
				)))
	);
}
function phraseMatches(
	key: string[],
	statements: string[][],
	context: EvaluationContext,
): boolean {
	if (!key.length) return false;
	return statements.some((statement) => {
		for (let start = 0; start <= statement.length - key.length; start++) {
			let matches = true;
			for (let offset = 0; offset < key.length; offset++) {
				context.operation();
				if (statement[start + offset] !== key[offset]) {
					matches = false;
					break;
				}
			}
			if (matches) return true;
		}
		return false;
	});
}
function keysMatch(
	entry: LoreEntry,
	statements: string[][],
	context: EvaluationContext,
): boolean {
	if (entry.always) return true;
	const matches = (key: string) =>
		phraseMatches(tokens(key), statements, context);
	return (
		entry.primaryKeys.some(matches) &&
		(!entry.secondaryKeys.length ||
			(entry.secondaryMode === "all"
				? entry.secondaryKeys.every(matches)
				: entry.secondaryKeys.some(matches)))
	);
}
/** Only permitted entries enter this function. Rejected nodes never contribute recursive text. */
export function evaluateLore(
	entries: LoreEntry[],
	context: EvaluationContext,
): { candidates: EvaluatedCandidate[]; truncated: boolean } {
	const visited = new Set<string>();
	const candidates: EvaluatedCandidate[] = [];
	const original = tokens(context.input.text);
	const recursiveText: string[][] = [];
	let truncated = false;
	for (let depth = 0; depth <= context.input.limits.maxDepth; depth++) {
		const available = [original, ...recursiveText];
		const next: string[][] = [];
		for (const entry of entries) {
			if (visited.has(entry.id)) continue;
			context.operation();
			if (
				!keysMatch(
					entry,
					depth === 0 || !entry.recursive ? [original] : available,
					context,
				)
			)
				continue;
			visited.add(entry.id);
			const key = `lore:${entry.id}`;
			// Cache success/rejection by visiting exactly once, after the first actual key match.
			if (!conditionPasses(entry.condition, entry.probability, context, key))
				continue;
			const text = evaluateText(entry.text, context, key);
			candidates.push({
				id: entry.id,
				kind: "lore",
				priority: entry.priority,
				entry: {
					id: entry.id,
					sourceId: entry.sourceId,
					placement: entry.placement,
					text,
				},
				effects: evaluateEffects(entry.effects, context, key),
			});
			if (entry.recursive) next.push(tokens(text));
		}
		if (!next.length) break;
		recursiveText.push(...next);
		if (depth === context.input.limits.maxDepth)
			truncated = entries.some(
				(e) =>
					!visited.has(e.id) &&
					e.recursive &&
					keysMatch(e, [original, ...recursiveText], context),
			);
	}
	return { candidates, truncated };
}
