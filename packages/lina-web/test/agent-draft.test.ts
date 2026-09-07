import { expect, test } from "bun:test";
import { DraftStore } from "../../lina-client/src/draft.ts";

test("agent drafts and unresolved sends stay separate while legacy Lina keys remain", () => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
	};
	const lina = new DraftStore(storage),
		kai = new DraftStore(storage, "kai");
	lina.saveDraft("Lina draft");
	lina.savePending({
		id: "request",
		sessionId: "lina-session",
		text: "Lina request",
	});
	kai.saveDraft("Kai draft");
	expect(data.get("lina.draft.v1")).toBe("Lina draft");
	expect(lina.draft()).toBe("Lina draft");
	expect(kai.draft()).toBe("Kai draft");
	expect(kai.pendingSends()).toEqual([]);
	kai.clearPending();
	expect(lina.pendingSends()).toHaveLength(1);
});
