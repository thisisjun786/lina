import type {
	AutonomySource,
	AutonomyState,
	LifeStep,
} from "./autonomy-types.ts";
import {
	array,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import { mergePublicationRoots } from "./publication-ancestry.ts";
import {
	type PublicationChainRef,
	type PublicationChainSnapshot,
	parsePublicationChainSnapshot,
} from "./publication-chains.ts";
import { pendingPublicationExperiences } from "./publication-experience.ts";
import type { PublicationSettings } from "./publication-types.ts";
import { fields, integer } from "./validation.ts";

type Limits = Pick<
	PublicationSettings,
	"maxChainDepth" | "maxActionsPerChain" | "perAuthorCooldownSteps"
>;
export interface PublicationBudgetSnapshot {
	version: 1;
	settingsRevision: number;
	chain: PublicationChainSnapshot;
	limits: Limits | null;
	blockedInputIds: string[];
	blockedCausalEventIds: string[];
}
export interface PublicationBudgetAction {
	kind: "step" | "causal_event";
	id: string;
	roots: PublicationChainRef[];
}

export function parsePublicationBudget(
	value: unknown,
): PublicationBudgetSnapshot {
	jsonBoundary(value);
	fields(value, [
		"version",
		"settingsRevision",
		"chain",
		"limits",
		"blockedInputIds",
		"blockedCausalEventIds",
	]);
	if (value.version !== 1)
		throw Error("Unsupported publication budget version");
	let limits: Limits | null = null;
	if (value.limits !== null) {
		fields(value.limits, [
			"maxChainDepth",
			"maxActionsPerChain",
			"perAuthorCooldownSteps",
		]);
		const { maxChainDepth, maxActionsPerChain, perAuthorCooldownSteps } =
			value.limits;
		integer(maxChainDepth, "publication depth", 0, MAX_LIFE_ITEMS);
		integer(maxActionsPerChain, "publication actions", 0, MAX_LIFE_ITEMS);
		limits = {
			maxChainDepth,
			maxActionsPerChain,
			perAuthorCooldownSteps: revision(perAuthorCooldownSteps),
		};
	}
	const settingsRevision = revision(value.settingsRevision);
	if ((settingsRevision === 0) !== (limits === null))
		throw Error("Publication budget settings mismatch");
	return {
		version: 1,
		settingsRevision,
		limits,
		chain: parsePublicationChainSnapshot(value.chain),
		blockedInputIds: keyed(
			array(value.blockedInputIds, identifier),
			(id) => id,
		),
		blockedCausalEventIds: keyed(
			array(value.blockedCausalEventIds, identifier),
			(id) => id,
		),
	};
}

function deeper(roots: PublicationChainRef[]): PublicationChainRef[] {
	return roots.map((root) => ({ ...root, depth: revision(root.depth + 1, 1) }));
}
function feedbackRoots(
	source: AutonomySource,
	blocked: readonly string[] = [],
): PublicationChainRef[] {
	const ids = new Set(
		pendingPublicationExperiences(source).map((row) => row.inputId),
	);
	for (const id of blocked) ids.delete(id);
	return mergePublicationRoots(
		(source.publication?.records ?? [])
			.filter((row) => ids.has(row.inputId))
			.map((row) => row.source.roots),
	);
}
function parentRoots(
	source: AutonomySource,
	id: string,
): PublicationChainRef[] {
	const record = source.publicationAncestry?.find(
		(row) => row.kind === "causal_event" && row.id === id,
	);
	if (!record || record.lifeRevision > source.life.revision)
		throw Error("Missing scheduled publication ancestry");
	return record.roots;
}
function allows(
	budget: PublicationBudgetSnapshot,
	roots: PublicationChainRef[],
	counts: ReadonlyMap<string, number>,
): boolean {
	if (!roots.length) return true;
	const limits = budget.limits;
	return (
		!!limits &&
		limits.maxChainDepth > 0 &&
		limits.maxActionsPerChain > 0 &&
		budget.chain.revision < Number.MAX_SAFE_INTEGER &&
		roots.every(
			(root) =>
				root.depth <= limits.maxChainDepth &&
				(counts.get(root.rootId) ?? 0) < limits.maxActionsPerChain,
		)
	);
}

/** Complete quantitative evidence is captured before selection, without changing authority records. */
export function freezePublicationBudget(
	source: AutonomySource,
	chain: PublicationChainSnapshot,
	settings: PublicationSettings | null,
): PublicationBudgetSnapshot {
	const snapshot = parsePublicationChainSnapshot(chain);
	if (
		snapshot.worldId !== source.pack.worldId ||
		(settings && settings.worldId !== snapshot.worldId) ||
		source.publication?.authority.settingsRevision !== (settings?.revision ?? 0)
	)
		throw Error("Publication budget source mismatch");
	const budget = parsePublicationBudget({
		version: 1,
		settingsRevision: settings?.revision ?? 0,
		chain: snapshot,
		limits: settings
			? {
					maxChainDepth: settings.maxChainDepth,
					maxActionsPerChain: settings.maxActionsPerChain,
					perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
				}
			: null,
		blockedInputIds: [],
		blockedCausalEventIds: [],
	});
	const counts = new Map(
		snapshot.roots.map((root) => [root.rootId, root.actions]),
	);
	const feedback = feedbackRoots(source);
	if (!allows(budget, deeper(feedback), counts))
		budget.blockedInputIds = pendingPublicationExperiences(source)
			.map((row) => row.inputId)
			.sort();
	const admitted = budget.blockedInputIds.length ? [] : feedback;
	for (const event of source.autonomy.pendingEvents) {
		if (event.status !== "pending") continue;
		const roots = deeper(
			mergePublicationRoots([admitted, parentRoots(source, event.id)]),
		);
		if (!allows(budget, roots, counts))
			budget.blockedCausalEventIds.push(event.id);
	}
	budget.blockedCausalEventIds.sort();
	return budget;
}

/** Settings and history authenticate the counters; the exclusions must also match the frozen inputs. */
export function assertPublicationBudget(
	source: AutonomySource,
	chain: PublicationChainSnapshot,
	settings: PublicationSettings | null,
): void {
	const actual = parsePublicationBudget(source.publicationBudget);
	const expected = freezePublicationBudget(source, chain, settings);
	if (lifeDigest(actual) !== lifeDigest(expected))
		throw Error("Corrupt frozen publication budget");
}

/** Changes to other roots do not revoke a step that cannot spend them. */
export function assertPublicationBudgetCurrent(
	source: AutonomySource,
	current: PublicationChainSnapshot,
): void {
	const budget = parsePublicationBudget(source.publicationBudget);
	if (current.worldId !== budget.chain.worldId)
		throw Error("Publication budget world mismatch");
	const roots = mergePublicationRoots([
		feedbackRoots(source),
		...source.autonomy.pendingEvents
			.filter((event) => event.status === "pending")
			.map((event) => parentRoots(source, event.id)),
	]);
	const before = new Map(
		budget.chain.roots.map((root) => [root.rootId, root.actions]),
	);
	const now = new Map(current.roots.map((root) => [root.rootId, root.actions]));
	if (
		roots.some(
			(root) => (before.get(root.rootId) ?? 0) !== (now.get(root.rootId) ?? 0),
		)
	)
		throw Error("Stale publication budget");
}

/** Deterministic accepted-step/queue accounting. No model, timer, or mutable counter is read here. */
export function applyPublicationBudget(
	step: LifeStep,
	state: AutonomyState,
): PublicationBudgetAction[] {
	if (step.version !== 3 || !step.source.publicationBudget) return [];
	const budget = parsePublicationBudget(step.source.publicationBudget);
	for (const event of state.pendingEvents)
		if (
			budget.blockedCausalEventIds.includes(event.id) &&
			event.status === "pending"
		)
			event.status = "stopped";
	const parent = step.decision.parent;
	if (parent && budget.blockedCausalEventIds.includes(parent.id))
		throw Error("Publication causal budget exhausted");
	const roots = deeper(
		mergePublicationRoots([
			feedbackRoots(step.source, budget.blockedInputIds),
			parent ? parentRoots(step.source, parent.id) : [],
		]),
	);
	if (!roots.length) return [];
	const counts = new Map(
		budget.chain.roots.map((root) => [root.rootId, root.actions]),
	);
	const actions: PublicationBudgetAction[] = [];
	const charge = (action: PublicationBudgetAction) => {
		if (
			actions.length >= Number.MAX_SAFE_INTEGER - budget.chain.revision ||
			!allows(budget, action.roots, counts)
		)
			return false;
		for (const root of action.roots)
			counts.set(root.rootId, (counts.get(root.rootId) ?? 0) + 1);
		actions.push(action);
		return true;
	};
	if (!charge({ kind: "step", id: step.id, roots }))
		throw Error("Publication step budget exhausted");
	for (const event of state.pendingEvents
		.filter(
			(event) => event.parentStepId === step.id && event.status === "pending",
		)
		.sort((a, b) => a.id.localeCompare(b.id))) {
		if (!charge({ kind: "causal_event", id: event.id, roots: deeper(roots) }))
			event.status = "stopped";
	}
	return actions;
}
