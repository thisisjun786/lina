import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { SCAN_MAX_LIMIT, SEARCH_MAX_LIMIT } from "../src/entries.ts";
import type { DurableStore } from "../src/store.ts";
import { entry, Fixture } from "./fixture.ts";

describe("durable context queries", () => {
	let fixture: Fixture;
	let store: DurableStore;
	beforeEach(() => {
		fixture = new Fixture();
		store = fixture.store();
	});
	afterEach(() => fixture.close());

	it("searches literal substrings with bounded hits, previews and cursors", () => {
		for (let i = 1; i <= 30; i++)
			store.appendEntry(entry(`hit-${i}`, { text: `needle number ${i}` }));
		store.appendEntry(entry("miss", { text: "nothing here" }));
		store.appendEntry(entry("meta", { role: "meta", text: "needle in meta" }));
		store.appendEntry(
			entry("pct", { role: "user", text: "100% done_now \\ back" }),
		);
		store.appendEntry(entry("case", { role: "user", text: "NEEDLE upper" }));
		store.appendEntry(
			entry("far", {
				role: "user",
				text: `${"p".repeat(2000)}needle${"s".repeat(2000)}`,
			}),
		);
		const page = store.search("needle");
		expect(page.messages).toHaveLength(SEARCH_MAX_LIMIT);
		expect(page.hasEarlier).toBe(true);
		expect(page.messages.at(-1)?.entryId).toBe("far");
		expect(page.messages.at(-1)?.text).toHaveLength(512);
		expect(page.messages.at(-1)?.text).toContain("needle");
		expect(page.messages.at(-1)?.truncated).toBe(true);
		expect(page.messages.map((m) => m.entryId)).not.toContain("meta");
		expect(page.messages.map((m) => m.entryId)).not.toContain("case");
		expect(page.messages.map((m) => m.entryId)).not.toContain("miss");
		expect(store.search("needle", { limit: 1000 }).messages).toHaveLength(
			SEARCH_MAX_LIMIT,
		);
		if (page.beforeCursor === null) throw new Error("missing cursor");
		const older = store.search("needle", { before: page.beforeCursor });
		expect(older.messages).toHaveLength(11);
		expect(older.messages[0]?.entryId).toBe("hit-1");
		expect(older.hasEarlier).toBe(false);
		expect(older.messages[0]?.text).toBe("needle number 1");
		expect(older.messages[0]?.truncated).toBe(false);
		// Wildcards and escapes are literal text, never patterns.
		expect(store.search("%").messages.map((m) => m.entryId)).toEqual(["pct"]);
		expect(store.search("_now").messages.map((m) => m.entryId)).toEqual([
			"pct",
		]);
		expect(store.search("\\ back").messages.map((m) => m.entryId)).toEqual([
			"pct",
		]);
		expect(store.search("n_edle").messages).toEqual([]);
		expect(store.search("%needle%").messages).toEqual([]);
		expect(store.search("zzz")).toEqual({
			messages: [],
			hasEarlier: false,
			beforeCursor: null,
		});
		for (const [query, options, pattern] of [
			[" ", {}, /blank/],
			["x".repeat(513), {}, /512/],
			["needle", { before: 0 }, /cursor/],
			["needle", { before: 1.5 }, /cursor/],
			["needle", { limit: 0 }, /limit/],
		] as const)
			expect(() => store.search(query, options)).toThrow(pattern);
		expect(store.revision()).toBe(35);
		expect(store.entry("pct")?.text).toBe("100% done_now \\ back");
	});

	it("scans every entry forward in bounded pages joined to request status", () => {
		const roles = ["user", "assistant", "tool", "meta"] as const;
		for (let i = 1; i <= 150; i++)
			store.appendEntry(entry(`e${i}`, { role: roles[i % 4] ?? "meta" }));
		store.createRequest("r1", "hello");
		store.setRequest("r1", "accepted");
		store.setRequest("r1", "settled", { entryId: "e5" });
		store.createRequest("r2", "hi");
		store.setRequest("r2", "rejected", { entryId: "e6", error: "no" });
		expect(store.scanAfter(0)).toHaveLength(SCAN_MAX_LIMIT);
		const first = store.scanAfter(0, 10);
		expect(first.map((row) => row.entry.entryId)).toEqual(
			Array.from({ length: 10 }, (_, i) => `e${i + 1}`),
		);
		expect(first[0]?.seq).toBe(1);
		expect(first[3]?.entry.role).toBe("user");
		expect(first[2]?.entry.role).toBe("meta");
		expect(first[4]).toEqual({
			seq: 5,
			entry: store.entry("e5") as never,
			requestStatus: "settled",
		});
		expect(first[5]?.requestStatus).toBe("rejected");
		expect("requestStatus" in (first[0] ?? {})).toBe(false);
		const last = store.scanAfter(140);
		expect(last.map((row) => row.seq)).toEqual(
			Array.from({ length: 10 }, (_, i) => 141 + i),
		);
		expect(store.scanAfter(150)).toEqual([]);
		for (const [after, limit, pattern] of [
			[-1, undefined, /scan cursor/],
			[0.5, undefined, /scan cursor/],
			[0, 0, /scan limit/],
			[0, 101, /scan limit/],
		] as const)
			expect(() => store.scanAfter(after, limit)).toThrow(pattern);
		expect(store.requestByEntry("e5")).toMatchObject({
			id: "r1",
			status: "settled",
			entryId: "e5",
		});
		expect(store.requestByEntry("e6")).toMatchObject({ id: "r2", error: "no" });
		expect(store.requestByEntry("e7")).toBeUndefined();
		expect(store.requestByEntry("")).toBeUndefined();
		// Queries never mutate: revision and schema are unchanged.
		expect(store.revision()).toBe(155);
		store.close();
		const db = new DatabaseSync(fixture.file);
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
				)
				.get()?.["n"],
		).toBe(11);
		db.close();
	});
});
