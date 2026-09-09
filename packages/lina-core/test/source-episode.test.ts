import { expect, test } from "bun:test";
import { entry, Fixture } from "./fixture.ts";

test("source episode includes unclassified intermediates and trusted late members in journal order without unrelated history", () => {
	const f = new Fixture(),
		store = f.store();
	try {
		store.appendEntry(entry("before"));
		store.createRequest("one", "hi");
		store.registerRequestSource({
			version: 1,
			purpose: "conversation",
			sessionId: f.binding.sessionId,
			requestId: "one",
			nativeEpoch: 1,
			scopeDigest: "a".repeat(64),
			contextReceiptIds: [],
		});
		store.appendSourceEntry(entry("u", { role: "user", text: "hi" }), "one");
		store.setRequest("one", "accepted", { entryId: "u" });
		store.appendEntry(
			entry("middle", {
				raw: { sourcePolicy: { scope: "ordinary" }, requestId: "one" },
			}),
		);
		store.appendSourceEntry(entry("a"), "one");
		store.setRequest("one", "settled");
		store.appendEntry(entry("next", { role: "user" }));
		store.appendEntry(entry("foreign"));
		store.appendSourceEntry(entry("late"), "one");
		const revision = store.revision();
		const selected = store.sourceEpisode("u");
		expect(selected.map((e) => e.entryId)).toEqual([
			"u",
			"middle",
			"a",
			"late",
		]);
		expect(selected[1]?.sourcePolicy).toBeUndefined();
		expect(selected[2]?.sourcePolicy?.requestId).toBe("one");
		expect(store.sourceEpisode("missing")).toEqual([]);
		expect(store.sourceEpisode("a")).toEqual([]);
		expect(store.revision()).toBe(revision);
		store.close();
		const reopened = f.store();
		expect(reopened.sourceEpisode("u").map((e) => e.entryId)).toEqual([
			"u",
			"middle",
			"a",
			"late",
		]);
	} finally {
		f.close();
	}
});

test("complete episode reads impose no source qualification or page cap and release their read scope on lookup failure", () => {
	const f = new Fixture(),
		store = f.store();
	try {
		store.appendEntry(entry("u", { role: "user" }));
		for (let n = 0; n < 130; n++) store.appendEntry(entry(`a-${n}`));
		expect(store.sourceEpisode("u")).toHaveLength(131);
		const read = store.sourceEntry.bind(store);
		store.sourceEntry = () => {
			throw Error("synthetic lookup failure");
		};
		expect(() => store.sourceEpisode("u")).toThrow("synthetic lookup failure");
		store.sourceEntry = read;
		store.appendEntry(entry("tail"));
		expect(store.sourceEpisode("u")).toHaveLength(132);
	} finally {
		f.close();
	}
});
