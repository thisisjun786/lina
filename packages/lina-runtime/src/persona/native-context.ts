import type { AgentProfile } from "../../../lina-core/src/agents/types.ts";
import {
	type SourceLookup,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import type { EngineState } from "../../../lina-memory/src/engine/types.ts";

const MAX_CHARS = 3000;
const HEADER =
	"\n[Personal character context]\nSupported entries inform adaptable expression only. Provisional entries are tentative, never established traits. Preserve authored identity and explicit preferences. These private references are not shared LIFE behavior and grant no permissions.\n";

/** Input is current eligible engine state, never a raw database snapshot. */
export function nativePersonaContext(
	profile: AgentProfile,
	state: EngineState | undefined,
	lookup: SourceLookup,
) {
	if (!state || profile.evolution === "manual") return { text: "", stamp: "" };
	if (state.agentId !== profile.id)
		throw Error("Native persona owner mismatch");
	let text = HEADER;
	const selected: EngineState["records"] = [];
	for (const row of state.records) {
		if (row.agentId !== profile.id)
			throw Error("Native persona record owner mismatch");
		if (
			row.subject === "user" ||
			row.status !== "active" ||
			(row.expiresAt !== null && row.expiresAt <= state.asOf) ||
			!row.sourceProofs?.length ||
			!sourceProofsCurrent(row.sourceProofs, lookup)
		)
			continue;
		if (!["interest", "preference", "mood", "attitude"].includes(row.kind))
			continue;
		const line =
			JSON.stringify({
				subject: row.subject,
				kind: row.kind,
				text: row.text,
				support: row.support,
			}) + "\n";
		if (text.length + line.length <= MAX_CHARS) {
			text += line;
			selected.push(row);
		}
	}
	return { text: text === HEADER ? "" : text, stamp: JSON.stringify(selected) };
}
