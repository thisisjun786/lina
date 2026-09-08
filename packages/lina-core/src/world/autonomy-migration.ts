import type { Scalar, WorldPackV3 } from "./authoring-types.ts";
import { assertAutonomyVariables } from "./autonomy-source.ts";
import type {
	AutonomyMigrationPreview,
	AutonomyState,
} from "./autonomy-types.ts";
import {
	assertAutonomyPack,
	parseAutonomyState,
} from "./autonomy-validation.ts";
import { lifeDigest, revision } from "./life-json.ts";
import type { EngineCheckpoint, LifeState } from "./life-types.ts";
import type { WorldSnapshot } from "./types.ts";

export interface AutonomyBoundary {
	worldRevision: number;
	lifeRevision: number;
	simulationTime: number;
}
export function rebindSocialCheckpoint(
	checkpoint: EngineCheckpoint,
	boundary: AutonomyBoundary,
	variables: Record<string, Scalar>,
): EngineCheckpoint {
	revision(boundary.worldRevision);
	revision(boundary.lifeRevision);
	revision(boundary.simulationTime);
	if (checkpoint.engineId === "empty") return structuredClone(checkpoint);
	const data = {
		...structuredClone(checkpoint.data),
		...boundary,
		variables: structuredClone(variables),
	};
	return { ...checkpoint, data, dataDigest: lifeDigest(data) };
}
export function initialAutonomyState(
	source: { world: WorldSnapshot; life: LifeState; pack: WorldPackV3 },
	seed: number,
): AutonomyState {
	const { world, life, pack } = source;
	assertAutonomyPack(pack);
	revision(seed);
	if (
		seed > 0xffffffff ||
		world.definition.id !== pack.worldId ||
		life.worldId !== pack.worldId ||
		life.worldRevision !== world.revision ||
		pack.version !== world.definition.version ||
		life.definitionRevision !== pack.life.revision
	)
		throw Error("Autonomy initial boundary mismatch");
	const cp = life.checkpoint;
	if (
		cp.engineId === "ensemble" &&
		(cp.data.worldRevision !== world.revision ||
			cp.data.lifeRevision !== life.revision ||
			cp.data.packVersion !== pack.version ||
			cp.data.simulationTime !== world.simulationTime)
	)
		throw Error("Autonomy checkpoint boundary mismatch");
	const variables =
		cp.engineId === "ensemble"
			? structuredClone(cp.data.variables)
			: Object.fromEntries(pack.variables.map((v) => [v.id, v.initial]));
	assertAutonomyVariables(pack, variables);
	return parseAutonomyState({
		version: 1,
		worldId: pack.worldId,
		worldRevision: world.revision,
		lifeRevision: life.revision,
		packVersion: pack.version,
		stepNumber: 0,
		seed,
		selectionIndex: 0,
		variables,
		needs: pack.roles
			.filter((x) => x.status === "active")
			.flatMap((r) =>
				pack.autonomy.needs.map((n) => ({
					agentId: r.agentId,
					needId: n.id,
					value: n.initial,
					lastStepId: null,
					experienceIds: [],
				})),
			),
		goals: pack.autonomy.goals.map((g) => ({
			...g,
			progress: 0,
			status: "active",
			createdAtStepId: null,
			lastStepId: null,
			experienceIds: [],
		})),
		families: [],
		pendingEvents: [],
	});
}
export function migrateAutonomyState(
	previous: AutonomyState,
	oldPack: WorldPackV3,
	nextPack: WorldPackV3,
	boundary: AutonomyBoundary,
): { state: AutonomyState; migration: AutonomyMigrationPreview } {
	const state = parseAutonomyState(previous);
	assertAutonomyPack(oldPack);
	assertAutonomyPack(nextPack);
	assertAutonomyVariables(oldPack, state.variables);
	if (
		oldPack.schemaVersion !== 3 ||
		nextPack.schemaVersion !== 3 ||
		state.worldId !== oldPack.worldId ||
		state.worldId !== nextPack.worldId ||
		state.packVersion !== oldPack.version ||
		nextPack.version !== oldPack.version + 1 ||
		boundary.worldRevision !== state.worldRevision + 1 ||
		boundary.lifeRevision !== state.lifeRevision + 1
	)
		throw Error("Autonomy migration boundary mismatch");
	revision(boundary.simulationTime);
	const operations: AutonomyMigrationPreview["operations"] = [];
	for (const n of oldPack.autonomy.needs)
		if (
			lifeDigest(n) !==
			lifeDigest(nextPack.autonomy.needs.find((x) => x.id === n.id) ?? null)
		)
			throw Error("Autonomy migration cannot reinterpret need");
	for (const g of oldPack.autonomy.goals)
		if (
			lifeDigest(g) !==
			lifeDigest(nextPack.autonomy.goals.find((x) => x.id === g.id) ?? null)
		)
			throw Error("Autonomy migration cannot reinterpret goal");
	for (const v of oldPack.variables)
		if (
			lifeDigest(v) !==
			lifeDigest(nextPack.variables.find((x) => x.id === v.id) ?? null)
		)
			throw Error("Autonomy migration cannot reinterpret variable");
	for (const role of oldPack.roles) {
		const next = nextPack.roles.find((x) => x.agentId === role.agentId);
		if (
			!next ||
			next.roleId !== role.roleId ||
			(role.status === "retired" && next.status !== "retired")
		)
			throw Error("Autonomy migration cannot reinterpret cast");
		if (role.status !== next.status)
			operations.push({ kind: "agent_retired", id: role.agentId });
	}
	for (const role of nextPack.roles)
		if (!oldPack.roles.some((x) => x.agentId === role.agentId))
			operations.push({ kind: "agent_added", id: role.agentId });
	for (const n of nextPack.autonomy.needs)
		if (!oldPack.autonomy.needs.some((x) => x.id === n.id))
			operations.push({ kind: "need_added", id: n.id });
	for (const r of nextPack.roles.filter((x) => x.status === "active"))
		for (const n of nextPack.autonomy.needs)
			if (
				!state.needs.some((x) => x.agentId === r.agentId && x.needId === n.id)
			)
				state.needs.push({
					agentId: r.agentId,
					needId: n.id,
					value: n.initial,
					lastStepId: null,
					experienceIds: [],
				});
	for (const authored of nextPack.autonomy.goals) {
		const accepted = state.goals.find((goal) => goal.id === authored.id);
		if (
			accepted &&
			(accepted.agentId !== authored.agentId ||
				accepted.description !== authored.description ||
				lifeDigest(accepted.familyIds) !== lifeDigest(authored.familyIds))
		)
			throw Error("Autonomy migration goal identity conflict");
	}
	for (const g of nextPack.autonomy.goals)
		if (!state.goals.some((x) => x.id === g.id)) {
			state.goals.push({
				...g,
				progress: 0,
				status: "active",
				createdAtStepId: null,
				lastStepId: null,
				experienceIds: [],
			});
			operations.push({ kind: "goal_added", id: g.id });
		}
	for (const v of nextPack.variables)
		if (!Object.hasOwn(state.variables, v.id))
			state.variables[v.id] = v.initial;
	if (
		lifeDigest(oldPack.autonomy) !== lifeDigest(nextPack.autonomy) ||
		lifeDigest(oldPack.variables) !== lifeDigest(nextPack.variables)
	)
		operations.push({ kind: "policy_changed", id: "autonomy" });
	state.worldRevision = boundary.worldRevision;
	state.lifeRevision = boundary.lifeRevision;
	state.packVersion = nextPack.version;
	const parsed = parseAutonomyState(state);
	assertAutonomyVariables(nextPack, parsed.variables);
	const body = {
		version: 1 as const,
		fromPackVersion: oldPack.version,
		toPackVersion: nextPack.version,
		worldRevision: boundary.worldRevision,
		lifeRevision: boundary.lifeRevision,
		previousStateDigest: lifeDigest(previous),
		nextStateDigest: lifeDigest(parsed),
		operations: operations.sort((a, b) =>
			`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1,
		),
	};
	return { state: parsed, migration: { ...body, digest: lifeDigest(body) } };
}
