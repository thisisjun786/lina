import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentInput } from "../../../lina-core/src/agents/types.ts";
/** Versioned authoring presets. Source SOULs are preserved separately, not executed. */
export function readPresets(workspace: string): AgentInput[] {
	return JSON.parse(
		readFileSync(resolve(workspace, "data/personas/presets.json"), "utf8"),
	) as AgentInput[];
}
