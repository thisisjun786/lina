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
import type { SocialMigrationPreview } from "./social-types.ts";
import { fields } from "./validation.ts";

export function parseSocialMigrationPreview(
	value: unknown,
): SocialMigrationPreview {
	jsonBoundary(value);
	fields(value, [
		"version",
		"algorithm",
		"fromPackVersion",
		"toPackVersion",
		"fromPackDigest",
		"toPackDigest",
		"previousCheckpointDigest",
		"nextCheckpointDigest",
		"worldRevision",
		"lifeRevision",
		"simulationTime",
		"operations",
		"digest",
	]);
	if (value.version !== 1 || value.algorithm !== "ensemble-migration-v1")
		throw Error("Unsupported social migration receipt");
	const body = {
		version: 1 as const,
		algorithm: "ensemble-migration-v1" as const,
		fromPackVersion: revision(value.fromPackVersion, 1),
		toPackVersion: revision(value.toPackVersion, 1),
		fromPackDigest: digest(value.fromPackDigest),
		toPackDigest: digest(value.toPackDigest),
		previousCheckpointDigest: digest(value.previousCheckpointDigest),
		nextCheckpointDigest: digest(value.nextCheckpointDigest),
		worldRevision: revision(value.worldRevision, 1),
		lifeRevision: revision(value.lifeRevision, 1),
		simulationTime: revision(value.simulationTime),
		operations: keyed(
			array(value.operations, (operation) => {
				fields(operation, ["kind", "id"]);
				return {
					kind: enumeration(operation.kind, [
						"predicate_added",
						"variable_added",
						"agent_added",
						"agent_retired",
						"rules_rebuilt",
					]),
					id: identifier(operation.id),
				};
			}),
			(x) => `${x.kind}:${x.id}`,
			false,
		),
	};
	if (
		body.toPackVersion !== body.fromPackVersion + 1 ||
		digest(value.digest) !== lifeDigest(body)
	)
		throw Error("Corrupt social migration receipt");
	return { ...body, digest: digest(value.digest) };
}
