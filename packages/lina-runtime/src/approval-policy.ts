export type ApprovalMode = "native" | "confirm";
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionDecision = { action: PermissionAction; reason?: string };
export type PermissionResolver = (
	name: string,
	input: unknown,
) => PermissionDecision;
export function parseApprovalMode(raw: string | undefined): ApprovalMode {
	if (raw === undefined) return "native";
	if (raw === "native" || raw === "confirm") return raw;
	throw new Error("LINA_APPROVAL_MODE must be native or confirm");
}
