import {
	authoringText,
	parseDeclarativeRule,
	parseLoreEntry,
} from "./authoring-node-validation.ts";
import type {
	AuthoringQuestion,
	EvaluationInput,
	EvaluationReceipt,
	ImportedWorldData,
	WorldPack,
} from "./authoring-types.ts";
import {
	parseEvaluationInput,
	parseWorldPack,
} from "./authoring-validation.ts";
import {
	array,
	canonicalLifeJson,
	identifier,
	jsonBoundary,
	lifeDigest,
} from "./life-json.ts";
import { evaluateLore, loreVisible } from "./lore.ts";
import {
	createEvaluationContext,
	type EvaluatedCandidate,
	evaluateRules,
	visibleTo,
} from "./rules.ts";

/** Caller binds actor, recipient and text to its permitted perception before calling. No effects persist. */
export function evaluateWorld(
	pack: WorldPack,
	input: EvaluationInput,
): EvaluationReceipt {
	const parsed = parseWorldPack(pack);
	const request = parseEvaluationInput(input);
	const context = createEvaluationContext(parsed, request);
	const lore = parsed.lore.filter((entry) => loreVisible(entry, request));
	const rules = parsed.rules.filter((rule) => visibleTo(rule.knownTo, request));
	const selected = evaluateLore(lore, context);
	const candidates = [...selected.candidates, ...evaluateRules(rules, context)];
	const result: EvaluationReceipt = {
		version: 1,
		worldId: request.worldId,
		agentId: request.agentId,
		recipientId: request.recipientId,
		evaluationId: request.evaluationId,
		// The outer author preview binds the complete pack digest. Actor receipts bind only permitted inputs.
		inputDigest: lifeDigest({
			...request,
			variables: context.variables,
			packVersion: parsed.version,
			lore,
			rules,
		}),
		seed: request.seed,
		entries: [],
		ruleIds: [],
		effects: [],
		variables: { ...context.variables },
		draws: [...context.draws.values()].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		),
		truncated: selected.truncated,
		digest: "0".repeat(64),
	};
	// Reserve true (one char shorter than false) only after establishing the complete envelope fits.
	if (canonicalLifeJson(result).length > request.limits.maxChars)
		throw Error("Authoring view budget cannot hold provenance");
	candidates.sort(
		(a, b) =>
			b.priority - a.priority ||
			(a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: a.kind < b.kind
						? -1
						: a.kind > b.kind
							? 1
							: 0),
	);
	let retained = 0;
	for (const candidate of candidates) {
		if (retained >= request.limits.maxRecords) {
			result.truncated = true;
			continue;
		}
		const trial = appendCandidate(result, candidate);
		if (canonicalLifeJson(trial).length > request.limits.maxChars) {
			result.truncated = true;
			continue;
		}
		Object.assign(result, trial);
		retained++;
	}
	const { digest: _digest, ...body } = result;
	result.digest = lifeDigest(body);
	return result;
}
function appendCandidate(
	receipt: EvaluationReceipt,
	candidate: EvaluatedCandidate,
): EvaluationReceipt {
	const variables = { ...receipt.variables };
	for (const effect of candidate.effects)
		if (effect.kind === "assign") variables[effect.variableId] = effect.value;
	return {
		...receipt,
		entries: candidate.entry
			? [...receipt.entries, candidate.entry]
			: receipt.entries,
		ruleIds:
			candidate.kind === "rule"
				? [...receipt.ruleIds, candidate.id]
				: receipt.ruleIds,
		effects: [...receipt.effects, ...candidate.effects],
		variables,
	};
}
/** Lina typed lore/rules only; unrecognized members are author-only inert JSON reports. */
export function importWorldData(value: unknown): ImportedWorldData {
	jsonBoundary(value);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Invalid authoring import object");
	const result: ImportedWorldData = { lore: [], rules: [], report: [] };
	const sourceId = (node: unknown, fallback: string) => {
		if (node && typeof node === "object")
			for (const key of ["sourceId", "id"]) {
				const field = Reflect.get(node, key);
				if (
					typeof field === "string" &&
					/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(field)
				)
					return field;
			}
		return fallback;
	};
	const report = (node: unknown, id: string, reason: string) => {
		result.report.push({
			sourceId: identifier(id),
			reason,
			rawJson: authoringText(canonicalLifeJson(node)),
		});
	};
	for (const [key, nodes] of Object.entries(value)) {
		if (key !== "lore" && key !== "rules") {
			report(
				nodes,
				/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)
					? key
					: `unsupported-${result.report.length}`,
				"Unsupported import field",
			);
			continue;
		}
		const seen = new Set<string>();
		for (const [index, node] of array(nodes, (item) => item).entries()) {
			try {
				if (key === "lore") {
					const entry = parseLoreEntry(node);
					if (seen.has(entry.id)) throw Error("Duplicate import lore ID");
					seen.add(entry.id);
					result.lore.push(entry);
				} else {
					const entry = parseDeclarativeRule(node);
					if (seen.has(entry.id)) throw Error("Duplicate import rule ID");
					seen.add(entry.id);
					result.rules.push(entry);
				}
			} catch (error) {
				report(
					node,
					sourceId(node, `${key}-${index}`),
					error instanceof Error ? error.message : "Unsupported import node",
				);
			}
		}
	}
	jsonBoundary(result);
	return result;
}
/** Structural readiness only. Operational config readiness belongs to the runtime config owner. */
export function worldReadiness(pack: WorldPack | null): AuthoringQuestion[] {
	if (pack === null)
		return [
			{
				id: "pack",
				question: "Provide a complete world definition.",
				blocking: true,
			},
		];
	const unresolved = structuredClone(pack.unresolved);
	const used = new Set(unresolved.map((question) => question.id));
	const append = (question: AuthoringQuestion) => {
		if (unresolved.length >= 4096)
			throw Error("World readiness question capacity exceeded");
		let key = question.id,
			suffix = 0;
		while (used.has(key)) key = `${question.id}-${++suffix}`;
		used.add(key);
		unresolved.push({ ...question, id: key });
	};
	if (!pack.roles.some((role) => role.status === "active"))
		append({
			id: "active-agents",
			question: "Choose at least one active world agent.",
			blocking: true,
		});
	if (!pack.world.places.length || !pack.world.scenes.length)
		append({
			id: "places",
			question: "Provide places and scenes for the world.",
			blocking: true,
		});
	return unresolved;
}
