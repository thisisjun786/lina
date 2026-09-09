import type {
	BotBinding,
	EntryInput,
} from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";

export function nativeOrigin(binding: BotBinding, requestId: string) {
	return {
		version: 1 as const,
		purpose: "conversation" as const,
		sessionId: binding.sessionId,
		requestId,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		contextReceiptIds: [],
	};
}
export function nativeEpisode(
	journal: DurableStore,
	binding: BotBinding,
	id: string,
	mixed = false,
) {
	journal.createRequest(id, "tea");
	journal.registerRequestSource(nativeOrigin(binding, id));
	for (const role of ["user", "assistant"] as const)
		journal.appendSourceEntry(
			{
				entryId: `${id}-${role}`,
				role,
				text: "tea",
				timestamp: "2026-09-08T00:00:00.000Z",
				raw: { type: "message", message: { role, stopReason: "stop" } },
			},
			id,
		);
	journal.setRequest(id, "accepted", { entryId: `${id}-user` });
	if (mixed) discloseNative(journal, id);
	journal.setRequest(id, "settled");
}
export function discloseNative(journal: DurableStore, requestId: string) {
	const id = `exposure-${requestId}`;
	journal.recordSourceExposure({
		type: "context_exposure",
		version: 1,
		id,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		source: { kind: "turn", requestId },
		materials: [{ kind: "disclosed-life", sourceId: "fiction" }],
		outcome: "planned",
	});
	journal.extendRequestSource(requestId, [id]);
}
/** Existing pre-provenance regressions explicitly opt into synthetic trusted transport. */
export function trustNativeFixture(
	journal: DurableStore,
	binding: BotBinding,
): void {
	const create = journal.createRequest.bind(journal),
		append = journal.appendEntry.bind(journal),
		set = journal.setRequest.bind(journal);
	let current: string | undefined;
	let unbound: EntryInput[] = [];
	journal.createRequest = (...args) => {
		const result = create(...args);
		journal.registerRequestSource(nativeOrigin(binding, args[0]));
		return result;
	};
	journal.appendEntry = (entry) => {
		if (entry.role === "user") {
			current = undefined;
			unbound = [];
		}
		if (current && entry.role !== "user")
			return journal.appendSourceEntry(entry, current);
		unbound.push(entry);
		return append(entry);
	};
	journal.setRequest = (...args) => {
		const entryId = args[2]?.entryId;
		if (entryId) {
			const source = journal.entry(entryId);
			if (source) journal.appendSourceEntry(source, args[0]);
		}
		const result = set(...args);
		const request = journal.request(args[0]);
		if (request?.entryId) {
			const source = journal.entry(request.entryId);
			if (source) journal.appendSourceEntry(source, request.id);
			for (const entry of unbound)
				if (entry.entryId !== request.entryId && entry.role !== "user")
					journal.appendSourceEntry(entry, request.id);
			unbound = [];
			current = request.id;
		}
		return result;
	};
}
