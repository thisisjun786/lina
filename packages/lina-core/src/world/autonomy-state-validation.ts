import { authoringText, scalar } from "./authoring-node-validation.ts";
import type { AutonomyState, GoalState } from "./autonomy-types.ts";
import { nonnegative, unitInterval } from "./autonomy-validation.ts";
import {
	array,
	enumeration,
	finite,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	nullableId,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export function parseGoalState(v: unknown): GoalState {
	fields(v, [
		"id",
		"agentId",
		"description",
		"priority",
		"familyIds",
		"progress",
		"status",
		"createdAtStepId",
		"lastStepId",
		"experienceIds",
	]);
	return {
		id: identifier(v.id),
		agentId: identifier(v.agentId),
		description: authoringText(v.description),
		priority: nonnegative(v.priority),
		familyIds: identifiers(v.familyIds),
		progress: unitInterval(v.progress),
		status: enumeration(v.status, ["active", "completed", "abandoned"]),
		createdAtStepId: nullableId(v.createdAtStepId),
		lastStepId: nullableId(v.lastStepId),
		experienceIds: identifiers(v.experienceIds),
	};
}
export function parseAutonomyState(value: unknown): AutonomyState {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"worldRevision",
		"lifeRevision",
		"packVersion",
		"stepNumber",
		"seed",
		"selectionIndex",
		"variables",
		"needs",
		"goals",
		"families",
		"pendingEvents",
	]);
	if (value.version !== 1) throw Error("Unsupported autonomy version");
	const vars = value.variables;
	if (!vars || typeof vars !== "object" || Array.isArray(vars))
		throw Error("Invalid autonomy variables");
	const variables = Object.fromEntries(
		Object.entries(vars).map(([k, v]) => [identifier(k), scalar(v)]),
	);
	const state: AutonomyState = {
		version: 1,
		worldId: identifier(value.worldId),
		worldRevision: revision(value.worldRevision),
		lifeRevision: revision(value.lifeRevision),
		packVersion: revision(value.packVersion, 1),
		stepNumber: revision(value.stepNumber),
		seed: revision(value.seed),
		selectionIndex: revision(value.selectionIndex),
		variables,
		needs: keyed(
			array(value.needs, (v) => {
				fields(v, [
					"agentId",
					"needId",
					"value",
					"lastStepId",
					"experienceIds",
				]);
				return {
					agentId: identifier(v.agentId),
					needId: identifier(v.needId),
					value: finite(v.value),
					lastStepId: nullableId(v.lastStepId),
					experienceIds: identifiers(v.experienceIds),
				};
			}),
			(x) => `${x.agentId}:${x.needId}`,
		),
		goals: keyed(array(value.goals, parseGoalState), (x) => x.id),
		families: keyed(
			array(value.families, (v) => {
				fields(v, ["familyId", "agentId", "lastStepNumber", "count"]);
				return {
					familyId: identifier(v.familyId),
					agentId: identifier(v.agentId),
					lastStepNumber: revision(v.lastStepNumber),
					count: revision(v.count, 1),
				};
			}),
			(x) => `${x.familyId}:${x.agentId}`,
		),
		pendingEvents: keyed(
			array(value.pendingEvents, (v) => {
				fields(v, [
					"id",
					"familyId",
					"actorIds",
					"summary",
					"parentStepId",
					"rootStepId",
					"depth",
					"status",
				]);
				return {
					id: identifier(v.id),
					familyId: identifier(v.familyId),
					actorIds: identifiers(v.actorIds),
					summary: authoringText(v.summary),
					parentStepId: identifier(v.parentStepId),
					rootStepId: identifier(v.rootStepId),
					depth: revision(v.depth, 1),
					status: enumeration(v.status, ["pending", "stopped"]),
				};
			}),
			(x) => x.id,
		),
	};
	if (
		state.seed > 0xffffffff ||
		state.selectionIndex > state.stepNumber ||
		state.stepNumber > state.lifeRevision ||
		state.lifeRevision > state.worldRevision ||
		state.families.some((x) => x.lastStepNumber > state.stepNumber)
	)
		throw Error("Invalid autonomy state continuity");
	return state;
}
