export type MemoryBackend = "native" | "honcho" | "disabled";
export function parseMemoryBackend(value: string | undefined): MemoryBackend {
	if (value === undefined) return "native";
	if (value === "native" || value === "honcho" || value === "disabled")
		return value;
	throw Error("LINA_MEMORY_BACKEND must be native, honcho or disabled");
}
