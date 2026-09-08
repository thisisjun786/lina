import type { EntryInput } from "../src/protocol.ts";
import type { DurableStore } from "../src/store.ts";

/** Existing context regressions use explicitly qualified synthetic source episodes. */
export function appendContextEntry(
	journal: DurableStore,
	sessionId: string,
	input: EntryInput,
	settle = true,
	mixed = false,
) {
	const requestId = `context-${input.entryId}`;
	journal.createRequest(
		requestId,
		input.text.slice(0, 16000) || "Synthetic archive fixture",
	);
	journal.registerRequestSource({
		version: 1,
		purpose: "conversation",
		sessionId,
		requestId,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		contextReceiptIds: [],
	});
	const userEntryId =
		input.role === "user" ? input.entryId : `${input.entryId}-creating-user`;
	if (input.role !== "user") {
		journal.appendSourceEntry(
			{
				entryId: userEntryId,
				role: "user",
				text: "Synthetic archive request",
				timestamp: input.timestamp,
				raw: {},
			},
			requestId,
		);
	}
	journal.appendSourceEntry(input, requestId);
	journal.setRequest(requestId, "accepted", { entryId: userEntryId });
	if (mixed) extendContextEntry(journal, requestId, true);
	if (settle) journal.setRequest(requestId, "settled");
	return requestId;
}

export function extendContextEntry(
	journal: DurableStore,
	requestId: string,
	mixed = false,
) {
	const id = `exposure-${requestId}-${journal.requestSourcePolicy(requestId)?.policyRevision}`;
	journal.recordSourceExposure({
		type: "context_exposure",
		version: 1,
		id,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		source: { kind: "tool", requestId, callId: id, toolName: "fixture" },
		materials: mixed
			? [{ kind: "disclosed-life", sourceId: "synthetic-secret" }]
			: [],
		outcome: "planned",
	});
	journal.extendRequestSource(requestId, [id]);
}
