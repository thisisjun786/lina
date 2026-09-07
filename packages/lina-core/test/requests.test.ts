import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { entry, Fixture } from "./fixture.ts";

describe("durable requests", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("deduplicates exact IDs and canonical full text across reopen", () => {
		let store = fixture.store();
		const text = "x".repeat(16000);
		const first = store.createRequest("one", text);
		expect(first.created).toBe(true);
		expect(first.request).toMatchObject({
			id: "one",
			text,
			status: "queued",
			sessionId: "session-1",
		});
		expect(new Date(first.request.createdAt).toISOString()).toBe(
			first.request.createdAt,
		);
		expect(first.request).not.toHaveProperty("error");
		expect(first.request).not.toHaveProperty("entryId");
		expect(store.revision()).toBe(1);
		store.close();
		store = fixture.store();
		expect(store.createRequest("one", text)).toEqual({
			request: first.request,
			created: false,
		});
		expect(store.requests()).toEqual([first.request]);
		expect(() => store.createRequest("one", `${text.slice(0, -1)}z`)).toThrow(
			/conflict/i,
		);
		expect(store.revision()).toBe(1);
		expect(store.createRequest("two", text).created).toBe(true);
	});

	it("rejects oversize text before journal mutation", () => {
		const store = fixture.store();
		expect(() => store.createRequest("bad", "x".repeat(16001))).toThrow();
		expect(store.request("bad")).toBeUndefined();
		expect(store.revision()).toBe(0);
	});

	it("rejects blank text and empty or overlong IDs at the store boundary", () => {
		const store = fixture.store();
		for (const id of ["", "   ", "i".repeat(129)]) {
			expect(() => store.createRequest(id, "valid text")).toThrow();
		}
		for (const text of ["", " \n\t "]) {
			expect(() => store.createRequest("valid", text)).toThrow();
		}
		expect(store.revision()).toBe(0);
		expect(store.requests()).toEqual([]);
		expect(
			store.createRequest("i".repeat(128), "  keep whitespace  ").request.text,
		).toBe("  keep whitespace  ");
	});

	it("permits admission and correlation, rejects regressions and terminal overwrites", () => {
		const store = fixture.store();
		store.createRequest("one", "hi");
		expect(() => store.setRequest("one", "settled")).toThrow();
		store.setRequest("one", "accepted");
		store.appendEntry(entry("source", { role: "user", text: "hi" }));
		expect(
			store.setRequest("one", "accepted", { entryId: "source" }).entryId,
		).toBe("source");
		expect(() => store.setRequest("one", "queued")).toThrow();
		const settled = store.setRequest("one", "settled");
		const revision = store.revision();
		expect(store.setRequest("one", "settled")).toEqual(settled);
		for (const status of [
			"queued",
			"accepted",
			"rejected",
			"interrupted",
		] as const) {
			expect(() => store.setRequest("one", status)).toThrow();
		}
		expect(() =>
			store.setRequest("one", "settled", { error: "late callback" }),
		).toThrow();
		expect(store.revision()).toBe(revision);
		expect(() => store.setRequest("unknown", "accepted")).toThrow();
	});

	it("recovers only pending requests atomically without replay and survives reopen", () => {
		let store = fixture.store();
		for (const id of ["queued", "accepted", "rejected", "settled"])
			store.createRequest(id, id);
		store.setRequest("accepted", "accepted");
		store.setRequest("rejected", "rejected", { error: "busy" });
		store.setRequest("settled", "accepted");
		store.setRequest("settled", "settled");
		store.close();
		store = fixture.store();
		expect(store.request("queued")?.status).toBe("queued");
		const revision = store.revision();
		expect(store.recover()).toBe(2);
		expect(store.revision()).toBeGreaterThan(revision);
		expect(store.request("queued")?.status).toBe("interrupted");
		expect(store.request("accepted")?.status).toBe("interrupted");
		expect(store.request("rejected")).toMatchObject({
			status: "rejected",
			error: "busy",
		});
		expect(store.request("settled")?.status).toBe("settled");
		const recoveredRevision = store.revision();
		expect(store.recover()).toBe(0);
		expect(store.revision()).toBe(recoveredRevision);
		expect(() => store.setRequest("queued", "accepted")).toThrow();
		store.close();
		store = fixture.store();
		expect(store.request("accepted")?.status).toBe("interrupted");
	});

	it("returns bounded recent requests with full text and errors", () => {
		const store = fixture.store();
		for (let i = 0; i < 30; i++)
			store.createRequest(`id-${i}`, "a".repeat(8000));
		store.setRequest("id-29", "rejected", { error: "e".repeat(8000) });
		expect(store.requests()).toHaveLength(20);
		expect(store.requests(1)[0]).toMatchObject({
			id: "id-29",
			text: "a".repeat(8000),
			error: "e".repeat(8000),
		});
		expect(() => store.requests(-1)).toThrow();
	});

	it("rolls back correlation errors and all recovery rows when SQLite aborts a write", () => {
		const store = fixture.store();
		store.createRequest("first", "one");
		store.createRequest("second", "two");
		expect(() =>
			store.setRequest("first", "accepted", { entryId: "missing" }),
		).toThrow();
		expect(store.request("first")?.status).toBe("queued");
		expect(store.revision()).toBe(2);
		const db = new DatabaseSync(fixture.file);
		try {
			db.exec(
				"CREATE TRIGGER fail_recovery BEFORE UPDATE ON requests WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END",
			);
			expect(() => store.recover()).toThrow(/disk failure fixture/);
			expect(store.requests().map((request) => request.status)).toEqual([
				"queued",
				"queued",
			]);
			expect(store.revision()).toBe(2);
			db.exec("DROP TRIGGER fail_recovery");
			expect(store.recover()).toBe(2);
		} finally {
			db.close();
		}
	});
});
