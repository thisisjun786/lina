import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import { parseLifeInput } from "../../../lina-core/src/world/life-validation.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { ResourceActivities } from "../../../lina-memory/src/resources/activities.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";

/** Synchronous admission precedes acknowledgement; interrupted delivery replays the same input. */
export function createResourceActivityBridge(options: {
	source: Pick<ResourceActivities, "pending" | "current" | "ack">;
	scope: ResourceScope;
	world: Pick<WorldStore, "admitWorkInput">;
}) {
	const scope = structuredClone(options.scope);
	return {
		poll(worldId: string): { delivered: number; replayed: number } {
			const result = { delivered: 0, replayed: 0 };
			const failures: unknown[] = [];
			for (const { source } of options.source.pending(scope, worldId)) {
				try {
					if (!options.source.current(scope, worldId, source)) continue;
					const input = parseLifeInput({
						version: 4,
						worldId,
						id: source.deliveryId,
						sourceRevision: source.receipt.activityRevision,
						source,
						payloadDigest: lifeDigest(source),
						consumedLifeRevision: null,
					});
					if (input.version !== 4)
						throw Error("Invalid resource activity input version");
					const receipt = options.world.admitWorkInput(input);
					if (
						receipt.worldId !== worldId ||
						receipt.inputId !== input.id ||
						receipt.payloadDigest !== input.payloadDigest
					)
						throw Error("Resource activity admission receipt mismatch");
					if (!options.source.current(scope, worldId, source))
						throw Error("Resource activity authority changed during admission");
					options.source.ack(scope, {
						operationId: `ack-${lifeDigest({ worldId, deliveryId: source.deliveryId })}`,
						deliveryId: source.deliveryId,
						sourceDigest: source.sourceDigest,
					});
					result.delivered++;
					if (receipt.replayed) result.replayed++;
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length) {
				if (failures.length === 1) throw failures[0];
				throw new AggregateError(
					failures,
					"Resource activity deliveries failed",
				);
			}
			return result;
		},
	};
}
