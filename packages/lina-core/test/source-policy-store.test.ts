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
