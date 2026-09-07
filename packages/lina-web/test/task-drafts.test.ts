import { expect, test } from "bun:test";
import { TaskDraftStore } from "../../lina-client/src/task-drafts.ts";

function memory() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}
test("task drafts and all-owner scope survive a new client without mixing conversations", () => {
	const storage = memory();
	storage.setItem("lina.draft.v1.lina", "agent draft");
	const first = new TaskDraftStore(storage);
	expect(first.set("task-a", { input: "한글 초안", owner: "kai" })).toBe(true);
	expect(first.set("task-b", { input: "different task" })).toBe(true);
	first.setScope("all");
	const next = new TaskDraftStore(storage);
	expect(next.get("task-a")).toEqual({ input: "한글 초안", owner: "kai" });
	expect(next.get("task-b")).toEqual({ input: "different task" });
	expect(next.scope()).toBe("all");
	expect(storage.getItem("lina.draft.v1.lina")).toBe("agent draft");
	next.delete("task-a");
	expect(new TaskDraftStore(storage).get("task-a")).toBeUndefined();
});
test("failed persistence retains an in-memory draft and flushes before leaving", () => {
	const storage = memory();
	let fail = true;
	const store = new TaskDraftStore({
		...storage,
		setItem(key, value) {
			if (fail) throw Error("quota");
			storage.setItem(key, value);
		},
	});
	expect(store.set("task-a", { input: "keep me" })).toBe(false);
	expect(store.get("task-a")?.input).toBe("keep me");
	expect(store.flush()).toBe(false);
	fail = false;
	expect(store.flush()).toBe(true);
	expect(new TaskDraftStore(storage).get("task-a")?.input).toBe("keep me");
});
test("malformed device data never becomes task input", () => {
	const storage = memory();
	storage.setItem("lina.task-draft.v1.task-a", '{"input":42}');
	storage.setItem("lina.task-scope.v1", "unexpected");
	const store = new TaskDraftStore(storage);
	expect(store.get("task-a")).toBeUndefined();
	expect(store.scope()).toBe("selected");
});

test("discarding a never-saved draft permits leaving without a storage service", () => {
	const store = new TaskDraftStore();
	expect(store.set("task-a", { input: "temporary" })).toBe(false);
	expect(store.set("task-a", { input: "" })).toBe(true);
	expect(store.flush()).toBe(true);
	expect(store.get("task-a")).toBeUndefined();
});
