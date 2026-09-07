import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DurableStore } from "../src/store.ts";
import { entry, Fixture } from "./fixture.ts";

describe("durable entries", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("replays source IDs idempotently, rejects changed content, preserves raw JSON", () => {
		let store = fixture.store();
		const source = entry("source", {
			text: "x".repeat(20000),
			raw: {
				branch: "a",
				content: [{ text: "x".repeat(20000), metadata: null }],
			},
		});
		expect(store.appendEntry(source)).toBe(true);
		expect(store.appendEntry(structuredClone(source))).toBe(false);
		for (const patch of [
			{ text: "changed" },
			{ raw: { branch: "b" } },
			{ role: "user" as const },
			{ timestamp: "2026-09-05T11:00:00.000Z" },
		]) {
			expect(() => store.appendEntry({ ...source, ...patch })).toThrow(
				/conflict/i,
			);
		}
		expect(store.entry("missing")).toBeUndefined();
		expect(store.revision()).toBe(1);
		expect(store.history().messages[0]).toMatchObject({
			text: "x".repeat(4096),
			truncated: true,
		});
		store.close();
		store = fixture.store();
		expect(store.entry("source")).toEqual(source);
		expect(store.appendEntry(source)).toBe(false);
		expect(store.appendEntry({ ...source, entryId: "different-id" })).toBe(
			true,
		);
		expect(store.revision()).toBe(2);
	});

	it("paginates visible rows chronologically with bounded stable cursors across new appends", () => {
		const store = fixture.store();
		expect(store.history()).toEqual({
			messages: [],
			hasEarlier: false,
			beforeCursor: null,
		});
		for (let i = 1; i <= 250; i++) {
			store.appendEntry(
				entry(`visible-${i}`, { role: i % 2 ? "user" : "tool" }),
			);
			store.appendEntry(entry(`meta-${i}`, { role: "meta" }));
		}
		const latest = store.history();
		expect(latest.messages).toHaveLength(100);
		expect(latest.messages[0]?.entryId).toBe("visible-151");
		expect(latest.messages.at(-1)?.entryId).toBe("visible-250");
		expect(latest.hasEarlier).toBe(true);
		expect(latest.beforeCursor).toBe(latest.messages[0]?.seq ?? null);
		expect(store.history({ limit: 10000 }).messages).toHaveLength(200);
		store.appendEntry(entry("new"));
		if (latest.beforeCursor === null) throw new Error("missing cursor");
		const older = store.history({ before: latest.beforeCursor, limit: 200 });
		expect(older.messages).toHaveLength(150);
		expect(older.messages[0]?.entryId).toBe("visible-1");
		expect(older.messages.at(-1)?.entryId).toBe("visible-150");
		expect(older.hasEarlier).toBe(false);
		expect(store.history({ before: 1 })).toEqual({
			messages: [],
			hasEarlier: false,
			beforeCursor: null,
		});
		expect(() => store.history({ before: NaN })).toThrow();
		expect(() => store.history({ limit: -1 })).toThrow();
	});

	it("bounds non-BMP previews by JS characters and keeps raw detail separate", () => {
		const store = fixture.store();
		store.appendEntry(entry("emoji", { text: "😀".repeat(4096) }));
		const preview = store.history().messages[0];
		expect(preview?.text).toBe("😀".repeat(2048));
		expect(preview?.truncated).toBe(true);
	});

	it("rejects foreign binding and unknown schema without adopting or rewriting data", () => {
		const store = fixture.store();
		store.appendEntry(entry("kept"));
		store.close();
		for (const patch of [
			{ botId: "foreign" },
			{ sessionId: "foreign" },
			{ sessionFile: `${fixture.binding.sessionFile}.other` },
		]) {
			expect(
				() => new DurableStore(fixture.file, { ...fixture.binding, ...patch }),
			).toThrow();
		}
		const db = new DatabaseSync(fixture.file);
		db.exec("PRAGMA user_version = 999");
		db.close();
		const bytes = readFileSync(fixture.file);
		expect(() => fixture.store()).toThrow(/schema/i);
		expect(readFileSync(fixture.file)).toEqual(bytes);
	});

	it("refuses an unrelated SQLite database or arbitrary nonempty file unchanged", () => {
		const db = new DatabaseSync(fixture.file);
		db.exec(
			"CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep')",
		);
		db.close();
		const bytes = readFileSync(fixture.file);
		expect(() => fixture.store()).toThrow();
		expect(readFileSync(fixture.file)).toEqual(bytes);
		writeFileSync(fixture.file, "unrelated file");
		expect(() => fixture.store()).toThrow();
		expect(readFileSync(fixture.file, "utf8")).toBe("unrelated file");
	});

	it("rejects altered owned schemas, unknown objects and corrupt revision metadata", () => {
		fixture.store().close();
		const db = new DatabaseSync(fixture.file);
		try {
			db.exec("CREATE TABLE unexpected(value TEXT)");
			expect(() => fixture.store()).toThrow(/schema/i);
			db.exec("DROP TABLE unexpected");
			db.exec("UPDATE meta SET value = 'NaN' WHERE key = 'revision'");
			expect(() => fixture.store()).toThrow(/revision|schema/i);
		} finally {
			db.close();
		}
	});

	it("refuses initialized nonempty SQLite files even when no tables exist", () => {
		const db = new DatabaseSync(fixture.file);
		db.exec("VACUUM");
		db.close();
		const bytes = readFileSync(fixture.file);
		expect(bytes.length).toBeGreaterThan(0);
		expect(() => fixture.store()).toThrow(/schema/i);
		expect(readFileSync(fixture.file)).toEqual(bytes);
	});
});
