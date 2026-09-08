import { TaskError } from "./task-types.ts";
import type { WorkAuthority, WorkVerifierContext } from "./task-work-types.ts";
import { workId } from "./task-work-validation.ts";

type Authority =
	| { kind: "local-management"; actorId: string; ownerAgentId: string }
	| {
			kind: "verifier";
			verifierId: string;
			verify: (context: WorkVerifierContext) => boolean;
	  };
const authorities = new WeakMap<WorkAuthority, Authority>();
function mint(value: Authority): WorkAuthority {
	// Capability identity is held in this module; serialized/cloned objects fail lookup.
	const port = Object.freeze({}) as WorkAuthority;
	authorities.set(port, value);
	return port;
}
/** Call from protected local-management composition, with the resolved task owner. */
export function createWorkManagementAuthority(
	actorId: string,
	ownerAgentId: string,
): WorkAuthority {
	return mint({
		kind: "local-management",
		actorId: workId(actorId),
		ownerAgentId: workId(ownerAgentId),
	});
}
/** Registration is application code, never JSON or a model-generated verifier label. */
export function createWorkVerifierAuthority(
	verifierId: string,
	verify: (context: WorkVerifierContext) => boolean,
): WorkAuthority {
	if (typeof verify !== "function")
		throw new TaskError("invalid_input", "verifier callback required");
	return mint({ kind: "verifier", verifierId: workId(verifierId), verify });
}
export function authorizeWork(
	authority: WorkAuthority,
	ownerAgentId: string,
	operation: "confirm" | "correct" | "share",
	context?: WorkVerifierContext,
): {
	identity: string;
	kind: "owner_confirmation" | "verifier";
	authorityId: string;
} {
	const trusted = authorities.get(authority);
	if (!trusted)
		throw new TaskError("unauthorized", "trusted work authority required");
	if (trusted.kind === "local-management") {
		if (trusted.ownerAgentId !== ownerAgentId)
			throw new TaskError(
				"unauthorized",
				"work authority does not own current task",
			);
		return {
			identity: JSON.stringify([
				trusted.kind,
				trusted.actorId,
				trusted.ownerAgentId,
			]),
			kind: "owner_confirmation",
			authorityId: trusted.actorId,
		};
	}
	if (
		operation !== "confirm" ||
		!context ||
		trusted.verify(structuredClone(context)) !== true
	)
		throw new TaskError(
			"unauthorized",
			"registered verifier did not authorize this evidence",
		);
	return {
		identity: JSON.stringify([trusted.kind, trusted.verifierId]),
		kind: "verifier",
		authorityId: trusted.verifierId,
	};
}
