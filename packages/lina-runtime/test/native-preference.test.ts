import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { nativePreferences } from "../src/persona/native-preferences.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("native preference replay uses original request receipt and reset wins across retry", async () => {
	const f = createRuntimeFixture();
	const store = new ConversationStore(join(f.root, "prefs.sqlite"));
	const source = {
		entryId: "u",
		role: "user" as const,
		text: "Keep replies brief",
		timestamp: new Date().toISOString(),
		raw: {},
	};
	f.store.createRequest("request", source.text);
	f.store.appendEntry(source);
	f.store.setRequest("request", "accepted", { entryId: "u" });
	f.store.setRequest("request", "settled");
	let calls = 0;
	const release = Promise.withResolvers<string>();
	const p = nativePreferences(store, "lina", f.store, async () => {
		calls++;
		return release.promise;
	});
	try {
		const run = p.process(
			source,
			p.resetRevision(),
			new AbortController().signal,
		);
		store.clearPreferences("lina", 0);
		release.resolve(
			JSON.stringify({
				communicationPreferences: [
					{
						dimension: "verbosity",
						value: "brief",
						quote: "Keep replies brief",
					},
				],
			}),
		);
		await run;
		expect(store.getPreferences("lina").items).toEqual([]);
		expect(p.hasReceipt("u")).toBe(true);
		await p.process(source, 0, new AbortController().signal);
		expect(calls).toBe(1);
		expect(store.hasPreferenceReceipt("lina", "request")).toBe(true);
	} finally {
		store.close();
		await f.close();
	}
});

test("older preference retry cannot replace a newer correction but preserves other dimensions", async () => {
	const f = createRuntimeFixture();
	const store = new ConversationStore(join(f.root, "prefs.sqlite"));
	const old = {
		entryId: "old",
		role: "user" as const,
		text: "Keep replies brief and no emoji",
		timestamp: new Date().toISOString(),
		raw: {},
	};
	const newer = { ...old, entryId: "new", text: "Give detailed answers" };
	for (const source of [old, newer]) {
		f.store.createRequest(source.entryId, source.text);
		f.store.appendEntry(source);
		f.store.setRequest(source.entryId, "accepted", { entryId: source.entryId });
		f.store.setRequest(source.entryId, "settled");
	}
	try {
		store.observePreferences(
			"lina",
			"new",
			"new",
			newer.text,
			[{ dimension: "verbosity", value: "detailed", quote: newer.text }],
			() => ({ role: "user", entryId: "new", text: newer.text }),
		);
		const p = nativePreferences(store, "lina", f.store, async () =>
			JSON.stringify({
				communicationPreferences: [
					{
						dimension: "verbosity",
						value: "brief",
						quote: "Keep replies brief",
					},
					{ dimension: "emoji", value: "none", quote: "no emoji" },
				],
			}),
		);
		await p.process(old, p.resetRevision(), new AbortController().signal);
		expect(
			store
				.getPreferences("lina")
				.items.find((p) => p.dimension === "verbosity")?.value,
		).toBe("detailed");
		expect(
			store.getPreferences("lina").items.find((p) => p.dimension === "emoji")
				?.value,
		).toBe("none");
	} finally {
		store.close();
		await f.close();
	}
});
