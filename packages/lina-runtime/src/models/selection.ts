import type { ModelProfile, ModelRole, ModelSettings } from "./types.ts";
import { validModelId, validModelRole } from "./validation.ts";

/**
 * Pure selection from a validated snapshot; overrideId is for isolated dry-runs
 * and bypasses role reasoning so the override profile is used exactly as saved.
 * Ordinary role resolution overlays agent role reasoning, then global role
 * reasoning, over the selected profile's own reasoning.
 */
export function resolveProfile(
	settings: ModelSettings,
	role: ModelRole,
	agentId?: string,
	overrideId?: string,
): ModelProfile | null {
	validModelRole(role);
	if (agentId !== undefined) validModelId(agentId, "agent id");
	if (overrideId !== undefined) validModelId(overrideId, "override profile id");
	const agent =
		agentId !== undefined && Object.hasOwn(settings.agentRoles, agentId)
			? settings.agentRoles[agentId]
			: undefined;
	const id =
		overrideId ??
		(agent && Object.hasOwn(agent, role) ? agent[role] : undefined) ??
		(Object.hasOwn(settings.roles, role) ? settings.roles[role] : undefined) ??
		settings.defaultProfileId;
	if (id === null) return null;
	const selected = settings.profiles.find((profile) => profile.id === id);
	if (!selected) throw new Error("unknown model profile reference");
	if (overrideId !== undefined) return { ...selected };
	const agentReasoning =
		agentId !== undefined &&
		settings.agentRoleReasoning &&
		Object.hasOwn(settings.agentRoleReasoning, agentId)
			? settings.agentRoleReasoning[agentId]
			: undefined;
	const reasoning =
		(agentReasoning && Object.hasOwn(agentReasoning, role)
			? agentReasoning[role]
			: undefined) ??
		(settings.roleReasoning && Object.hasOwn(settings.roleReasoning, role)
			? settings.roleReasoning[role]
			: undefined) ??
		selected.reasoning;
	return { ...selected, reasoning };
}
