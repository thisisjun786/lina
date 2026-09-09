import { Type } from "typebox";
/** Compatibility names only. Old remote URIs must not be silently reinterpreted as local data. */
export function workTools() {
	return [
		"lina_work_list",
		"lina_work_read",
		"lina_work_search",
		"lina_work_write",
	].map((name) => ({
		name,
		label: "Retired work memory tool",
		description:
			"Retired external memory adapter. Use Lina resource tools and stable resource IDs.",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute(
			_callId: string,
			_input: Record<string, unknown>,
			_signal?: AbortSignal,
		): never {
			throw Error(
				"Legacy work memory tool retired; use lina_resource_list/read/search/put. External data has not been imported.",
			);
		},
	}));
}
