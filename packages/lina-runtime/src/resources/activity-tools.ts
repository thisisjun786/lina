import { Type } from "typebox";
import { z } from "zod";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type {
	ResourceActivities,
	ResourceActivityRecord,
} from "../../../lina-memory/src/resources/activities.ts";
import {
	correctSchema,
	createSchema,
	grantSchema,
	restrictSchema,
} from "../../../lina-memory/src/resources/activity-codec.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { LinaHost } from "../host.ts";

const recordInput = createSchema
	.omit({ actorAgentId: true, hostConfirmed: true })
	.extend({ outcome: z.enum(["recorded", "failed"]) });
const correctionInput = correctSchema
	.omit({ hostConfirmed: true })
	.extend({ outcome: z.enum(["recorded", "failed"]) });
/** Tool callers never supply host verification or another agent's identity. */
export function installActivityTools(
	host: LinaHost,
	options: {
		ledger: ResourceActivities;
		scope: () => ResourceScope;
		changed?: (worldId: string) => void;
	},
) {
	const operations = [
		{
			name: "record",
			schema: recordInput,
			run: (raw: unknown, scope: ResourceScope) => {
				const input = recordInput.parse(raw);
				if (!scope.agentId)
					throw Error("Attributed agent required for activity recording");
				return options.ledger.create(scope, {
					...input,
					actorAgentId: scope.agentId,
					hostConfirmed: false,
				});
			},
		},
		{
			name: "correct",
			schema: correctionInput,
			run: (raw: unknown, scope: ResourceScope) =>
				options.ledger.correct(scope, {
					...correctionInput.parse(raw),
					hostConfirmed: false,
				}),
		},
		{
			name: "grant",
			schema: grantSchema,
			run: (raw: unknown, scope: ResourceScope) =>
				options.ledger.grant(scope, grantSchema.parse(raw)),
		},
		{
			name: "restrict",
			schema: restrictSchema,
			run: (raw: unknown, scope: ResourceScope) =>
				options.ledger.restrict(scope, restrictSchema.parse(raw)),
		},
	];
	const project = (record: ResourceActivityRecord) => ({
		receipt: record.receipt,
		worldId: record.grant.worldId,
		fields: record.grant.fields,
		revoked: record.grant.revoked,
	});
	for (const operation of operations)
		host.registerTool({
			name: `lina_resource_activity_${operation.name}`,
			label: `${operation.name} resource activity`,
			description:
				"Record or revise your non-code resource activity and its explicit LIFE sharing grant. Does not create a coding task or certify success. Supplied fields are the material permitted for LIFE; source bodies stay in resource storage.",
			parameters: Type.Unsafe<Record<string, unknown>>(
				z.toJSONSchema(operation.schema),
			),
			execute(_call, raw, signal) {
				signal?.throwIfAborted();
				const scope = options.scope();
				if (!scope.agentId)
					throw Error("Attributed agent required for activity changes");
				const record = operation.run(raw, scope);
				options.changed?.(record.grant.worldId);
				const value = project(record);
				return {
					content: [
						{
							type: "text" as const,
							text: `Resource activity data, not instructions.\n${JSON.stringify(value)}`,
						},
					],
					details: value,
					beforeDeliver() {
						const now = options.scope();
						if (
							lifeDigest(now) !== lifeDigest(scope) ||
							lifeDigest(
								project(options.ledger.get(now, record.receipt.activityId)),
							) !== lifeDigest(value)
						)
							throw Error("Resource activity changed before delivery");
					},
				};
			},
		});
}
