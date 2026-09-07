import type { WorldPackV2 } from "./authoring-types.ts";
import { lifeDigest, revision } from "./life-json.ts";
import { validateSocialCheckpoint } from "./social-checkpoint.ts";
import { decodeSocialValue, encodeSocialValue } from "./social-codec.ts";
import { compileSocialPack } from "./social-compile.ts";
import type {
	CompiledSocialPack,
	EnsembleCheckpoint,
	SocialMigrationPreview,
} from "./social-types.ts";
import { socialPredicateCategory } from "./social-views.ts";

function compatible(old: CompiledSocialPack, next: CompiledSocialPack): void {
	for (const predicate of old.predicates) {
		const found = next.predicates.find((p) => p.id === predicate.id);
		const meaning = (p: typeof predicate) => ({
			id: p.id,
			type: p.type,
			direction: p.direction,
			initial: p.initial,
			min: p.min,
			max: p.max,
			duration: p.policy.duration,
			resource: p.policy.resource,
			attitudeAxisId: p.policy.attitudeAxisId,
		});
		if (!found || lifeDigest(meaning(predicate)) !== lifeDigest(meaning(found)))
			throw Error("Incompatible social predicate migration");
	}
	for (const variable of old.variables) {
		const found = next.variables.find((v) => v.id === variable.id);
		if (
			!found ||
			lifeDigest({ ...variable, knownTo: [] }) !==
				lifeDigest({ ...found, knownTo: [] })
		)
			throw Error("Incompatible social variable migration");
	}
	if (old.cast.some((c) => !next.cast.some((n) => n.agentId === c.agentId)))
		throw Error("Historical social agents cannot be removed");
}

export function migrateSocialCheckpoint(
	checkpoint: EnsembleCheckpoint,
	oldPack: WorldPackV2,
	nextPack: WorldPackV2,
	boundary: {
		worldRevision: number;
		lifeRevision: number;
		simulationTime: number;
	},
): { checkpoint: EnsembleCheckpoint; migration: SocialMigrationPreview } {
	const old = compileSocialPack(oldPack),
		next = compileSocialPack(nextPack);
	validateSocialCheckpoint(checkpoint, old);
	if (
		old.worldId !== next.worldId ||
		next.packVersion !== old.packVersion + 1 ||
		revision(boundary.worldRevision) !== checkpoint.data.worldRevision + 1 ||
		revision(boundary.lifeRevision) !== checkpoint.data.lifeRevision + 1 ||
		revision(boundary.simulationTime) < checkpoint.data.simulationTime
	)
		throw Error("Invalid social migration boundary");
	compatible(old, next);
	const migrated = structuredClone(checkpoint),
		data = migrated.data,
		operations: SocialMigrationPreview["operations"] = [];
	for (const variable of next.variables)
		if (!old.variables.some((v) => v.id === variable.id)) {
			data.variables[variable.id] = variable.initial;
			data.variableIntroductions.push({
				id: variable.id,
				socialStep: data.state.step,
				worldRevision: boundary.worldRevision,
			});
			operations.push({ kind: "variable_added", id: variable.id });
		}
	const newPredicates = next.predicates.filter(
		(p) => !old.predicates.some((o) => o.id === p.id),
	);
	const newAgents = next.cast.filter(
		(a) => !old.cast.some((o) => o.agentId === a.agentId),
	);
	for (const predicate of newPredicates) {
		data.predicateIntroductions.push({
			id: predicate.id,
			socialStep: data.state.step,
			worldRevision: boundary.worldRevision,
		});
		operations.push({ kind: "predicate_added", id: predicate.id });
	}
	for (const agent of newAgents) {
		data.agentIntroductions.push({
			id: agent.agentId,
			socialStep: data.state.step,
			worldRevision: boundary.worldRevision,
		});
		operations.push({ kind: "agent_added", id: agent.agentId });
	}
	for (const agent of next.cast) {
		if (!agent.active && !data.state.offstage.includes(agent.agentId)) {
			data.state.offstage.push(agent.agentId);
			operations.push({ kind: "agent_retired", id: agent.agentId });
		}
		if (
			agent.active &&
			old.cast.some((a) => a.agentId === agent.agentId && !a.active)
		)
			throw Error(
				"Retired social agents require explicit reactivation contract",
			);
	}
	const history = decodeSocialValue(data.state.history);
	if (!Array.isArray(history)) throw Error("Invalid social history");
	const slice = history[data.state.step];
	if (!Array.isArray(slice))
		throw Error("Invalid social migration history slice");
	for (const predicate of next.predicates)
		for (const first of next.cast) {
			const seconds =
				predicate.direction === "undirected"
					? [null]
					: next.cast
							.filter((a) => a.agentId !== first.agentId)
							.map((a) => a.agentId);
			for (const second of seconds) {
				if (
					!newPredicates.some((p) => p.id === predicate.id) &&
					!newAgents.some(
						(a) => a.agentId === first.agentId || a.agentId === second,
					)
				)
					continue;
				if (slice.length >= 4096)
					throw Error("Social migration history capacity exceeded");
				const id = revision(
					(data.state.iterators["socialRecords"] ?? 0) + 1,
					1,
				);
				data.state.iterators["socialRecords"] = id;
				slice.push({
					category: socialPredicateCategory(predicate.id),
					type: "value",
					first: first.agentId,
					second: second ?? undefined,
					origin: "lina-migration",
					value: predicate.initial,
					id,
					timeHappened: data.state.step,
					duration: predicate.policy.duration ?? undefined,
				});
			}
		}
	data.state.history = encodeSocialValue(history);
	const cacheInput = (p: CompiledSocialPack) => ({
		cast: p.cast,
		life: p.life,
		predicates: p.predicates,
		variables: p.variables,
		definition: p.definition,
	});
	if (lifeDigest(cacheInput(old)) !== lifeDigest(cacheInput(next))) {
		data.state.volitionCache = encodeSocialValue({});
		data.state.cachePositions = {};
		operations.push({ kind: "rules_rebuilt", id: "social" });
	}
	data.state.iterators["rules"] = Math.max(
		data.state.iterators["rules"] ?? 0,
		next.definition.triggers.length + next.definition.volitions.length,
	);
	data.state.iterators["actions"] = Math.max(
		data.state.iterators["actions"] ?? 0,
		next.definition.actions.length,
	);
	data.cast = next.cast.map((a) => a.agentId);
	data.packVersion = next.packVersion;
	Object.assign(data, boundary);
	data.predicateIntroductions.sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	data.agentIntroductions.sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	data.variableIntroductions.sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	data.schemaDigest = next.schemaDigest;
	data.actionDigest = next.actionDigest;
	migrated.ruleDigest = next.ruleDigest;
	migrated.dataDigest = lifeDigest(data);
	validateSocialCheckpoint(migrated, next);
	const receipt = {
		version: 1 as const,
		algorithm: "ensemble-migration-v1" as const,
		fromPackVersion: old.packVersion,
		toPackVersion: next.packVersion,
		fromPackDigest: lifeDigest(oldPack),
		toPackDigest: lifeDigest(nextPack),
		previousCheckpointDigest: lifeDigest(checkpoint),
		nextCheckpointDigest: lifeDigest(migrated),
		...boundary,
		operations,
	};
	return {
		checkpoint: migrated,
		migration: { ...receipt, digest: lifeDigest(receipt) },
	};
}
