import { expect, test } from "bun:test";
import { DraftStore } from "../client/draft.ts";

test("draft and pending ID survive reload without executing a send", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
	const store = new DraftStore(storage);
	store.saveDraft("unsent");
	store.savePending({ id: "r1", text: "sent", sessionId: "fixed" });
	const restored = new DraftStore(storage);
	expect(restored.draft()).toBe("unsent");
	expect(restored.pending()?.id).toBe("r1");
	restored.clearPending();
	expect(restored.pending()).toBeUndefined();
	expect(restored.draft()).toBe("unsent");
});

test("blocked or corrupt browser storage cannot break chat", () => {
	const store = new DraftStore({
		getItem() {
			throw new Error("blocked");
		},
		setItem() {
			throw new Error("blocked");
		},
		removeItem() {
			throw new Error("blocked");
		},
	});
	expect(store.draft()).toBe("");
	expect(store.pending()).toBeUndefined();
	expect(() => store.saveDraft("text")).not.toThrow();
	expect(() => store.clearPending()).not.toThrow();
});

test("a new send cannot erase a previous unconfirmed send", () => {
	const values = new Map<string, string>();
	const store = new DraftStore({
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	});
	store.savePending({ id: "old", text: "unconfirmed", sessionId: "s" });
	store.savePending({ id: "new", text: "new message", sessionId: "s" });
	expect(store.pendingSends().map((send) => send.id)).toEqual(["old", "new"]);
	store.clearPending("new");
	expect(store.pendingSends().map((send) => send.id)).toEqual(["old"]);
});

test("update must detect a lost draft write instead of claiming it is safe to reload", () => {
	const blocked = new DraftStore({
		getItem: () => "older",
		setItem: () => {},
		removeItem: () => {},
	});
	expect(blocked.saveDraft("unsent attachment reference")).toBe(false);
	const missing = new DraftStore(undefined);
	expect(missing.saveDraft("unsent")).toBe(false);
});
