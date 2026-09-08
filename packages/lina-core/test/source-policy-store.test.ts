import { afterEach, describe, expect, it } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { isOrdinarySource } from "../src/source-policy.ts";
import { entry, Fixture } from "./fixture.ts";
import { SOURCE_JOURNAL_V1 } from "./source-policy-v1-fixture.ts";

const resources: Fixture[] = [];
afterEach(() => {
	for (const fixture of resources.splice(0)) fixture.close();
});
function fixture() {
	const item = new Fixture();
	resources.push(item);
	return item;
}
const scopeDigest = "a".repeat(64);
function exposure(id: string, requestId: string, secret = false) {
	return {
		type: "context_exposure" as const,
		version: 1 as const,
		id,
		nativeEpoch: 1,
		scopeDigest,
		source: { kind: "turn" as const, requestId },
		materials: secret
			? [{ kind: "disclosed-life" as const, sourceId: "private-life-event" }]
			: [],
		outcome: "planned" as const,
	};
}
function origin(
	f: Fixture,
	requestId: string,
	contextReceiptIds: string[] = [],
) {
	return {
		version: 1 as const,
		purpose: "conversation" as const,
		sessionId: f.binding.sessionId,
		requestId,
		nativeEpoch: 1,
		scopeDigest,
		contextReceiptIds,
	};
}

describe("journal source persistence", () => {
	it("rejects mismatched user correlation on writes and withholds uncorrelated settled episodes", () => {
		const f = fixture();
		let store = f.store();
		store.createRequest("r", "first");
		store.registerRequestSource(origin(f, "r"));
		store.appendSourceEntry(
			entry("first", { role: "user", text: "first" }),
			"r",
		);
		store.appendEntry(entry("other", { role: "user", text: "other" }));
		expect(() =>
			store.setRequest("r", "accepted", { entryId: "other" }),
		).toThrow(/source|correlation/i);
		store.setRequest("r", "accepted", { entryId: "first" });
		store.setRequest("r", "settled");
		expect(() =>
			store.appendSourceEntry(entry("second", { role: "user" }), "r"),
		).toThrow();
		expect(store.entry("second")).toBeUndefined();
		store.createRequest("orphan", "orphan");
		store.registerRequestSource(origin(f, "orphan"));
		store.appendSourceEntry(entry("orphan-a"), "orphan");
		store.setRequest("orphan", "accepted");
		store.setRequest("orphan", "settled");
		expect(isOrdinarySource(store.sourceEntry("orphan-a"))).toBe(false);
		store.close();
		store = f.store();
		expect(isOrdinarySource(store.sourceEntry("orphan-a"))).toBe(false);
		expect(isOrdinarySource(store.sourceEntry("first"))).toBe(true);
	});

	it("rejects receipts from a different source epoch and corrupted originating request IDs", () => {
		const f = fixture();
		const store = f.store();
		store.createRequest("r1", "r1");
		store.registerRequestSource(origin(f, "r1"));
		expect(() =>
			store.recordSourceExposure({
				...exposure("bad", "r1"),
				nativeEpoch: 2,
				scopeDigest: "b".repeat(64),
			}),
		).toThrow(/source/i);
		store.recordSourceExposure(exposure("valid", "r1"));
		store.extendRequestSource("r1", ["valid"]);
		store.appendSourceEntry(entry("u", { role: "user", text: "r1" }), "r1");
		store.setRequest("r1", "accepted", { entryId: "u" });
		store.setRequest("r1", "settled");
		store.close();
		const db = new DatabaseSync(f.file);
		db.exec(
			"UPDATE source_exposures SET receipt_json=json_set(receipt_json,'$.source.requestId','nonexistent')",
		);
		db.close();
		expect(() => f.store()).toThrow(/source/i);
	});

	it("rejects violated legacy CHECK constraints before migration and preserves the old schema", () => {
		const f = fixture(),
			db = new DatabaseSync(f.file);
		db.exec(SOURCE_JOURNAL_V1);
		for (const [key, value] of [
			["binding", JSON.stringify(f.binding)],
			["schema_version", "1"],
			["revision", "0"],
		] as const)
			db.prepare("INSERT INTO meta VALUES (?,?)").run(key, value);
		db.exec("PRAGMA user_version=1; PRAGMA ignore_check_constraints=ON");
		db.prepare(
			"INSERT INTO entries VALUES (1,'broken',?,'unknown','text','text',0,'{}','now')",
		).run(f.binding.sessionId);
		db.prepare(
			"INSERT INTO requests VALUES ('broken-r',?,'text','unknown','now','now',NULL,'broken')",
		).run(f.binding.sessionId);
		db.close();
		expect(() => f.store()).toThrow(/constraint|journal|source/i);
		const after = new DatabaseSync(f.file);
		expect(after.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
			1,
		);
		expect(
			after
				.prepare("SELECT name FROM sqlite_schema WHERE name='source_requests'")
				.get(),
		).toBeUndefined();
		after.close();
	});
	it("migrates actual v1 bytes without relabeling legacy rows or losing pending requests", () => {
		const f = fixture();
		const db = new DatabaseSync(f.file);
		db.exec(SOURCE_JOURNAL_V1);
		for (const [key, value] of [
			["binding", JSON.stringify(f.binding)],
			["schema_version", "1"],
			["revision", "9"],
		] as const)
			db.prepare("INSERT INTO meta VALUES (?,?)").run(key, value);
		db.prepare(
			"INSERT INTO entries VALUES (1,'old',?,'user','old text','old text',0,?,?)",
		).run(
			f.binding.sessionId,
			JSON.stringify({ scope: "ordinary" }),
			"2026-09-08T00:00:00Z",
		);
		db.prepare(
			"INSERT INTO requests VALUES ('old-r',?,'old text','accepted',?, ?,NULL,'old')",
		).run(f.binding.sessionId, "2026-09-08T00:00:00Z", "2026-09-08T00:00:00Z");
		db.exec("PRAGMA user_version=1");
		db.close();
		let store = f.store();
		expect(store.revision()).toBe(9);
		expect(store.request("old-r")?.status).toBe("accepted");
		expect(store.sourceEntry("old")?.sourcePolicy).toBeUndefined();
		expect(isOrdinarySource(store.sourceEntry("old"))).toBe(false);
		expect(store.entry("old")?.raw).toEqual({ scope: "ordinary" });
		store.close();
		store = f.store();
		expect(store.recover()).toBe(1);
		expect(store.request("old-r")?.status).toBe("interrupted");
		expect(store.revision()).toBe(10);
	});
	it("associates user and assistant atomically and survives a real reopen", () => {
		const f = fixture();
		let store = f.store();
		store.createRequest("r1", "hello");
		store.recordSourceExposure(exposure("e1", "r1"));
		store.registerRequestSource(origin(f, "r1", ["e1"]));
		store.appendSourceEntry(entry("u1", { role: "user", text: "hello" }), "r1");
		store.appendSourceEntry(entry("a1"), "r1");
		store.setRequest("r1", "accepted", { entryId: "u1" });
		expect(isOrdinarySource(store.sourceEntry("u1"))).toBe(false);
		store.setRequest("r1", "settled");
		expect(isOrdinarySource(store.sourceEntry("u1"))).toBe(true);
		expect(isOrdinarySource(store.sourceEntry("a1"))).toBe(true);
		const policy = store.requestSourcePolicy("r1"),
			revision = store.revision();
		expect(store.appendSourceEntry(entry("a1"), "r1")).toBe(false);
		store.registerRequestSource(origin(f, "r1", ["e1"]));
		expect(store.revision()).toBe(revision);
		store.close();
		store = f.store();
		expect(store.sourceEntry("a1")?.sourcePolicy).toEqual(policy);
		expect(store.sourceEntry("a1")?.requestStatus).toBe("settled");
	});

	it("planned midturn disclosure taints current entries but not an older settled episode", () => {
		const f = fixture(),
			store = f.store();
		for (const id of ["old", "current"]) {
			store.createRequest(id, id);
			store.registerRequestSource(origin(f, id));
			store.appendSourceEntry(entry(`${id}-u`, { role: "user", text: id }), id);
			store.setRequest(id, "accepted", { entryId: `${id}-u` });
			if (id === "old") store.setRequest(id, "settled");
		}
		store.recordSourceExposure(exposure("secret", "current", true));
		store.extendRequestSource("current", ["secret"]);
		expect(store.sourceEntry("current-u")?.sourcePolicy?.scope).toBe("mixed");
		expect(isOrdinarySource(store.sourceEntry("old-u"))).toBe(true);
		store.setRequest("current", "settled");
		expect(isOrdinarySource(store.sourceEntry("current-u"))).toBe(false);
		store.createRequest("later", "later");
		store.registerRequestSource(origin(f, "later", ["secret"]));
		expect(store.requestSourcePolicy("later")?.scope).toBe("mixed");
	});

	it("withholds legacy/raw labels and rejects missing or conflicting associations without partial append", () => {
		const f = fixture(),
			store = f.store();
		store.appendEntry(
			entry("legacy", {
				role: "user",
				raw: { sourcePolicy: { scope: "ordinary" } },
			}),
		);
		expect(isOrdinarySource(store.sourceEntry("legacy"))).toBe(false);
		expect(() =>
			store.appendSourceEntry(entry("missing"), "unknown"),
		).toThrow();
		expect(store.entry("missing")).toBeUndefined();
		for (const id of ["r1", "r2"]) {
			store.createRequest(id, id);
			store.registerRequestSource(origin(f, id));
		}
		store.appendSourceEntry(entry("owned"), "r1");
		expect(() => store.appendSourceEntry(entry("owned"), "r2")).toThrow(
			/source|conflict/i,
		);
		expect(() =>
			store.registerRequestSource({ ...origin(f, "r1"), nativeEpoch: 2 }),
		).toThrow();
		expect(() => store.extendRequestSource("r1", ["missing"])).toThrow();
		expect(store.requestSourcePolicy("r1")?.policyRevision).toBe(1);
	});

	it("accepts only exact planned→delivered receipt recovery and rejects weakened source history on reopen", () => {
		const f = fixture();
		let store = f.store();
		store.createRequest("r", "r");
		const receipt = exposure("e", "r", true);
		store.recordSourceExposure(receipt);
		store.registerRequestSource(origin(f, "r", ["e"]));
		store.recordSourceExposure({ ...receipt, outcome: "delivered" });
		expect(() =>
			store.recordSourceExposure({
				...receipt,
				outcome: "delivered",
				materials: [],
			}),
		).toThrow();
		store.close();
		store = f.store();
		expect(store.requestSourcePolicy("r")?.scope).toBe("mixed");
		store.close();
		const db = new DatabaseSync(f.file);
		db.exec(
			"UPDATE source_policies SET policy_json=json_set(policy_json,'$.scope','ordinary')",
		);
		db.close();
		expect(() => f.store()).toThrow(/source/i);
	});
});

it("J2 registration validates staged owned receipts even when omitted from the candidate list", () => {
	const f = fixture();
	let store = f.store();
	store.createRequest("r", "request");
	store.recordSourceExposure({
		...exposure("staged", "r"),
		nativeEpoch: 2,
		scopeDigest: "b".repeat(64),
	});
	const before = store.request("r");
	expect(() => store.registerRequestSource(origin(f, "r"))).toThrow(/source/i);
	expect(store.requestSourcePolicy("r")).toBeUndefined();
	expect(store.request("r")).toEqual(before);
	store.close();
	store = f.store();
	expect(store.requestSourcePolicy("r")).toBeUndefined();
	expect(
		store.registerRequestSource({
			...origin(f, "r"),
			nativeEpoch: 2,
			scopeDigest: "b".repeat(64),
			contextReceiptIds: ["staged"],
		}),
	).toBe(true);
	store.close();
	store = f.store();
	expect(store.requestSourcePolicy("r")?.policyRevision).toBe(1);
});
