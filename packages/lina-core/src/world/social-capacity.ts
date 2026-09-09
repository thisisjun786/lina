import { MAX_LIFE_ITEMS } from "./life-json.ts";
import type { EngineCheckpoint } from "./life-types.ts";
import { decodeSocialValue } from "./social-codec.ts";
import type { CompiledSocialPack, SocialLimits } from "./social-types.ts";

type Dimensions = Pick<CompiledSocialPack, "cast" | "predicates">;

/** Derive allocation limits from the existing complete-history and codec ceilings, before any Cartesian walk. */
export function assertSocialCapacity(
	pack: Dimensions,
	checkpoint?: EngineCheckpoint,
	limits?: SocialLimits,
): void {
	const count = pack.cast.length;
	// Upstream volition storage creates a pair slot even when there are no predicates.
	if (count * count > MAX_LIFE_ITEMS)
		throw Error("Social pair cache capacity exceeded");
	let cells = 0;
	for (const predicate of pack.predicates) {
		cells += predicate.direction === "undirected" ? count : count * (count - 1);
		// Every first resolution contains both the complete bootstrap and advanced slice.
		if (cells * 2 > MAX_LIFE_ITEMS)
			throw Error("Social history cell capacity exceeded");
	}
	if (!checkpoint || !limits) return;
	let records = cells;
	if (checkpoint.engineId === "ensemble") {
		const history = decodeSocialValue(checkpoint.data.state.history);
		if (!Array.isArray(history) || history.length + 1 > MAX_LIFE_ITEMS)
			throw Error("Social history slice capacity exceeded");
		records = 0;
		for (const slice of history) {
			if (!Array.isArray(slice)) throw Error("Invalid social history slice");
			records += slice.length;
		}
	}
	if (records + cells > Math.min(MAX_LIFE_ITEMS, limits.maxHistoryEntries))
		throw Error("Social next history capacity exceeded");
}
