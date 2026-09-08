import type { BotBinding } from "../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../lina-core/src/store.ts";
import { generationOwner } from "../../lina-memory/src/honcho/qualification.ts";
import {
	type FakeHoncho,
	fixtureAdapter,
	qualifiedConfig,
} from "../../lina-memory/test/honcho-fixture.ts";

export function qualifyRequest(
	store: DurableStore,
	binding: BotBinding,
	requestId: string,
	entryIds: string[],
) {
	store.registerRequestSource({
		version: 1,
		purpose: "conversation",
		sessionId: binding.sessionId,
		requestId,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		contextReceiptIds: [],
	});
	for (const id of entryIds) {
		const entry = store.entry(id);
		if (!entry) throw new Error(`missing fixture entry ${id}`);
		store.appendSourceEntry(entry, requestId);
	}
}
export function honchoOptions(
	store: DurableStore,
	binding: BotBinding,
	fake: FakeHoncho,
) {
	const sourceLookup = (id: string) => store.sourceEntry(id);
	return {
		fetch: fake.fetch,
		binding,
		sourceLookup,
		qualifiedAdapter: fixtureAdapter(
			generationOwner(binding, qualifiedConfig),
			sourceLookup,
		),
	};
}
