import type { WorkingState } from "../../../lina-core/src/context/index.ts";
import type { ContextServices } from "./port.ts";

export function contextInjection(
	working: WorkingState,
	recall: string,
	messages: readonly unknown[],
	services: ContextServices,
): { text: string; tokens: number; omitted: boolean } {
	const content = [
		working.goal,
		...working.decisions,
		...working.openItems,
		...working.nextSteps,
	].some(Boolean);
	if (!content && !recall) return { text: "", tokens: 0, omitted: false };
	const budget = Math.min(
		2048,
		services.contextWindow -
			services.reserveTokens -
			services.systemTokens -
			services.estimateMessages(messages),
	);
	const prefix =
		"[Reference data from prior work and memory. Latest user instructions override it.]\n";
	let capsule = content ? JSON.stringify(working) : "";
	let recalled = recall.slice(0, 4096);
	let text = `${prefix}Working state: ${capsule}\nMemory (freshness unknown): ${recalled}`;
	let omitted = recalled.length < recall.length;
	if (services.estimateText(text) > budget) {
		recalled = "";
		omitted = true;
		text = `${prefix}Working state: ${capsule}`;
	}
	while (capsule.length && services.estimateText(text) > budget) {
		capsule = capsule.slice(0, Math.floor(capsule.length * 0.75));
		text = `${prefix}Working state excerpt: ${capsule}\n[Abridged; use lina_status for current working state and lina_context_expand for archived sources]`;
		omitted = true;
	}
	if (services.estimateText(text) > budget)
		return { text: "", tokens: 0, omitted: true };
	return { text, tokens: services.estimateText(text), omitted };
}
