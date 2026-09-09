/** Independently authored subset used by the seven pinned Ensemble modules. */
export function ensembleCompatibility(random: () => number) {
	return {
		keys: (value: object) => Object.keys(value),
		size: (value: object | string | unknown[]) =>
			typeof value === "string" || Array.isArray(value)
				? value.length
				: Object.keys(value).length,
		random: (min: number, max?: number) => {
			const low = max === undefined ? 0 : min;
			const high = max ?? min;
			return low + Math.floor(random() * (high - low + 1));
		},
		sortBy: <T>(
			values: T[],
			iteratee: keyof T | ((value: T) => unknown),
		): T[] => {
			const ranked = values.map((value, index) => ({
				value,
				index,
				rank:
					typeof iteratee === "function" ? iteratee(value) : value[iteratee],
			}));
			ranked.sort((a, b) => {
				if (a.rank === b.rank) return a.index - b.index;
				if (a.rank === undefined) return 1;
				if (b.rank === undefined) return -1;
				// Pinned consumers rank finite numbers, strings, or undefined only.
				if (
					(typeof a.rank === "number" && typeof b.rank === "number") ||
					(typeof a.rank === "string" && typeof b.rank === "string")
				)
					return a.rank < b.rank ? -1 : 1;
				throw Error("Unsupported Ensemble sort key");
			});
			return ranked.map((item) => item.value);
		},
	};
}
