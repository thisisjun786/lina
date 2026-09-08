import type {
	AutonomyMigrationPreview,
	AutonomyState,
} from "./autonomy-types.ts";
import {
	array,
	digest,
	enumeration,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

/** Versioned migration proof is shape-checked here and independently replayed at admission/startup. */
export function parseAutonomyMigrationPreview(
	value: unknown,
): AutonomyMigrationPreview {
	jsonBoundary(value);
	fields(value, [
		"version",
		"fromPackVersion",
		"toPackVersion",
		"worldRevision",
		"lifeRevision",
		"previousStateDigest",
		"nextStateDigest",
		"operations",
		"digest",
	]);
	if (value.version !== 1)
		throw Error("Unsupported autonomy migration preview version");
	const result: AutonomyMigrationPreview = {
		version: 1,
		fromPackVersion: revision(value.fromPackVersion, 1),
		toPackVersion: revision(value.toPackVersion, 1),
		worldRevision: revision(value.worldRevision, 1),
		lifeRevision: revision(value.lifeRevision, 1),
		previousStateDigest: digest(value.previousStateDigest),
		nextStateDigest: digest(value.nextStateDigest),
		operations: keyed(
			array(value.operations, (item) => {
				fields(item, ["kind", "id"]);
				return {
					kind: enumeration(item.kind, [
						"need_added",
						"goal_added",
						"agent_added",
						"agent_retired",
						"policy_changed",
					]),
					id: identifier(item.id),
				};
			}),
			(x) => `${x.kind}:${x.id}`,
			false,
		),
		digest: digest(value.digest),
	};
	const { digest: saved, ...body } = result;
	if (
		result.toPackVersion !== result.fromPackVersion + 1 ||
		saved !== lifeDigest(body)
	)
		throw Error("Corrupt autonomy migration preview");
	return result;
}
export interface AutonomyDefinitionAccess {
	autonomyState(worldId: string): AutonomyState | null;
	autonomyStateAt(worldId: string, lifeRevision: number): AutonomyState | null;
	saveAutonomyState(state: AutonomyState): void;
}
