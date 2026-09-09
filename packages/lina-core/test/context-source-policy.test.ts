import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContextStore } from "../src/context/store.ts";
import { DurableStore } from "../src/store.ts";
import { ContextSourceFixture } from "./context-source-fixture.ts";

const fixtures: ContextSourceFixture[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.close();
});
function setup() {
	const f = new ContextSourceFixture();
	fixtures.push(f);
	const path = join(f.dir, "context.sqlite");
	const open = () =>
		f.keep(
			new ContextStore(path, f.binding, f.lookup, {
				lookupRequest: f.lookupRequest,
			}),
		);
	return { f, path, open };
}
const replacement = (goal: string, sourceEntryIds: string[] = []) => ({
	goal,
	decisions: [],
	openItems: [],
	nextSteps: [],
	sourceEntryIds,
});

test("summary ancestry, activation and expansion fail closed after a source revision changes", () => {
	const { f, open } = setup();
	f.add("ordinary");
	f.add("mixed", "SECRET", "settled", "mixed");
	const store = open();
	expect(() =>
		store.stage({
			text: "SECRET",
			kind: "model",
			sources: [{ kind: "entry", id: "mixed" }],
		}),
	).toThrow();
	const leaf = store.stage({
		text: "safe",
		kind: "model",
		sources: [{ kind: "entry", id: "ordinary" }],
	});
	const root = store.stage({
		text: "derived",
		kind: "model",
		sources: [{ kind: "summary", id: leaf.id }],
	});
	store.activate({
		id: root.id,
		expectedActiveId: null,
		nativeEntryId: "native",
		firstKeptEntryId: "ordinary",
	});
	f.extend("ordinary");
	expect(store.get(root.id)).toBeUndefined();
	expect(store.active()).toBeNull();
	expect(() => store.expand({ kind: "summary", id: root.id })).toThrow();
	expect(() =>
		store.activate({
			id: root.id,
			expectedActiveId: null,
			nativeEntryId: "native",
			firstKeptEntryId: "ordinary",
		}),
	).toThrow();
	expect(() => store.expand({ kind: "entry", id: "mixed" })).toThrow();
	expect(store.inspectSummary(root.id)?.text).toBe("derived");
});

test("ordinary pending working and notes finalize using final policy after empty exposure, with crash recovery", () => {
	const { f, open, path } = setup();
	f.add("user", "remember", "accepted");
	f.add("citation");
	let store = open();
	const options = { activeRequestId: "request-user" };
	store.updateWorking(0, replacement("finish", ["citation"]), options);
	const note = store.appendNote("call-1", "remember this", options);
	expect(note.status).toBe("pending");
	expect(store.notes()).toEqual([]);
	expect(store.working().goal).toBe("");
	expect(store.working(options).goal).toBe("finish");
	f.extend("user");
	expect(store.working(options).goal).toBe("finish");
	f.statuses.set("user", "settled");
	store.close(); // crash before finalization
	store = open();
	expect(store.notes().map((n) => n.text)).toEqual(["remember this"]);
	expect(store.working().goal).toBe("finish");
	store.finalizeRequest("request-user");
	store.close(); // crash after finalization
	store = open();
	expect(store.notes()).toHaveLength(1);
	expect(store.appendNote("call-1", "remember this", options).id).toBe(note.id);
	expect(() => store.appendNote("call-1", "changed", options)).toThrow(
		/conflict/,
	);
	const db = new DatabaseSync(path);
	expect(
		db.prepare("SELECT COUNT(*) n FROM context_finalizations").get()?.["n"],
	).toBe(2);
	db.close();
});

for (const failure of [
	"mixed",
	"interrupted",
	"citation",
	"identity",
] as const) {
	test(`pending artifacts withhold ${failure} and cannot be promoted after reopen`, () => {
		const { f, open } = setup();
		f.add("user", "SECRET", "accepted");
		f.add("citation");
		let store = open();
		const options = { activeRequestId: "request-user" };
		store.updateWorking(0, replacement("SECRET", ["citation"]), options);
		store.appendNote("call", "SECRET", options);
		if (failure === "mixed") f.extend("user", "mixed");
		if (failure === "citation") f.extend("citation");
		if (failure === "identity") {
			const p = f.policies.get("user");
			if (p) f.policies.set("user", { ...p, nativeEpoch: 2 });
		}
		f.statuses.set(
			"user",
			failure === "interrupted" ? "interrupted" : "settled",
		);
		store.finalizeRequest("request-user");
		store.close();
		store = open();
		expect(store.notes()).toEqual([]);
		expect(JSON.stringify(store.working())).not.toContain("SECRET");
		expect(store.inspectWorking().goal).toBe("SECRET");
	});
}

test("partial working edits retain mixed ancestry; a full replacement creates new ancestry", () => {
	const { f, open } = setup();
	f.add("bad", "SECRET", "accepted");
	f.add("clean", "clean", "accepted");
	const store = open();
	store.updateWorking(0, replacement("SECRET"), {
		activeRequestId: "request-bad",
	});
	f.extend("bad", "mixed");
	f.statuses.set("bad", "settled");
	store.updateWorking(
		1,
		{ decisions: ["clean decision"], sourceEntryIds: ["clean"] },
		{ activeRequestId: "request-clean" },
	);
	f.statuses.set("clean", "settled");
	store.finalizeRequest("request-clean");
	expect(JSON.stringify(store.working())).not.toContain("SECRET");
	expect(store.inspectWorking().goal).toBe("SECRET");
	store.updateWorking(2, replacement("new safe text"), {
		activeRequestId: "request-clean",
	});
	store.finalizeRequest("request-clean");
	expect(store.working().goal).toBe("new safe text");
});

test("strict context v1 migration preserves human history and withholds all unproven model text", () => {
	const { f, path, open } = setup();
	f.add("source");
	const db = new DatabaseSync(path);
	db.exec(
		readFileSync(new URL("./fixtures/context-v1.sql", import.meta.url), "utf8"),
	);
	db.prepare("INSERT INTO context_meta VALUES (?, ?)").run(
		"schema_version",
		"1",
	);
	db.prepare("INSERT INTO context_meta VALUES (?, ?)").run(
		"binding",
		JSON.stringify(f.binding),
	);
	db.exec(
		"PRAGMA user_version = 1; INSERT INTO working_state VALUES (1,1,'LEGACY_SECRET','[]','[]','[]','[]'); INSERT INTO summaries VALUES ('legacy','LEGACY_SECRET','model',0,'legacy-fingerprint','2026-09-08'); INSERT INTO summary_sources VALUES ('legacy','entry','source',0)",
	);
	db.close();
	let store = open();
	expect(store.working().goal).toBe("");
	expect(store.get("legacy")).toBeUndefined();
	expect(store.inspectWorking().goal).toBe("LEGACY_SECRET");
	expect(store.inspectSummary("legacy")?.text).toBe("LEGACY_SECRET");
	store.close();
	store = open();
	expect(store.get("legacy")).toBeUndefined();
	store.close();
	const corrupt = new DatabaseSync(path);
	corrupt.exec("CREATE TABLE surprise (x TEXT)");
	corrupt.close();
	expect(open).toThrow(/schema/);
});

test("finalization is atomic when the context write fails between proof and artifact status", () => {
	const { f, path, open } = setup();
	f.add("user", "ordinary", "accepted");
	let store = open();
	store.appendNote("call", "safe", { activeRequestId: "request-user" });
	f.statuses.set("user", "settled");
	const db = new DatabaseSync(path);
	db.exec(
		"CREATE TRIGGER crash_context_finalize BEFORE UPDATE ON context_artifacts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
	);
	expect(() => store.finalizeRequest("request-user")).toThrow(
		"synthetic write failure",
	);
	expect(
		db.prepare("SELECT COUNT(*) n FROM context_finalizations").get()?.["n"],
	).toBe(0);
	expect(
		db.prepare("SELECT status FROM context_artifacts").get()?.["status"],
	).toBe("pending");
	db.exec("DROP TRIGGER crash_context_finalize");
	db.close();
	store.close();
	store = open();
	expect(store.notes().map((n) => n.text)).toEqual(["safe"]);
});

for (const mode of ["before", "after"]) {
	test(`SIGKILL ${mode} finalization recovers exactly one eligible note from actual journal and context WALs`, async () => {
		const { f, path } = setup();
		const child = Bun.spawn(
			[
				process.execPath,
				new URL("./fixtures/context-finalization-process.ts", import.meta.url)
					.pathname,
				f.dir,
				JSON.stringify(f.binding),
				mode,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await child.exited).not.toBe(0);
		const journal = f.keep(
			new DurableStore(join(f.dir, "journal.sqlite"), f.binding),
		);
		const store = f.keep(
			new ContextStore(path, f.binding, (id) => journal.sourceEntry(id), {
				lookupRequest: (id) =>
					journal.sourceEntry(journal.request(id)?.entryId ?? ""),
			}),
		);
		expect(store.notes().map((n) => n.text)).toEqual([
			"survives process death",
		]);
		expect(store.finalizeRequest("context-user")).toBe(0);
		const db = new DatabaseSync(path);
		expect(
			db.prepare("SELECT COUNT(*) n FROM context_finalizations").get()?.["n"],
		).toBe(1);
		db.close();
	});
}

test("reopen rejects altered working text under an existing finalized creation", () => {
	const { f, path, open } = setup();
	f.add("user", "ordinary", "accepted");
	const store = open();
	store.updateWorking(0, replacement("original"), {
		activeRequestId: "request-user",
	});
	f.statuses.set("user", "settled");
	store.finalizeRequest("request-user");
	store.close();
	const db = new DatabaseSync(path);
	db.exec("UPDATE working_state SET goal = 'altered'");
	db.close();
	expect(open).toThrow(/working.*content/i);
});

test("explicit undefined cannot label retained mixed working text as a full replacement", () => {
	const { f, open } = setup();
	f.add("mixed", "SYNTHETIC_SECRET", "accepted");
	f.add("clean", "safe edit", "accepted");
	let store = open();
	store.updateWorking(0, replacement("SYNTHETIC_SECRET"), {
		activeRequestId: "request-mixed",
	});
	f.extend("mixed", "mixed");
	f.statuses.set("mixed", "settled");
	const attempted = {
		goal: undefined,
		decisions: ["safe edit"],
		openItems: undefined,
		nextSteps: undefined,
		sourceEntryIds: [],
	};
	// Exercise the public JavaScript boundary without weakening the strict TS input type.
	expect(() =>
		Reflect.apply(store.updateWorking, store, [
			1,
			attempted,
			{ activeRequestId: "request-clean" },
		]),
	).toThrow(/undefined/);
	f.statuses.set("clean", "settled");
	store.finalizeRequest("request-clean");
	store.close();
	store = open();
	expect(store.inspectWorking().goal).toBe("SYNTHETIC_SECRET");
	expect(store.inspectWorking().revision).toBe(1);
	expect(JSON.stringify(store.working())).not.toContain("SYNTHETIC_SECRET");
	store.updateWorking(1, replacement("safe replacement"), {
		activeRequestId: "request-clean",
	});
	store.finalizeRequest("request-clean");
	expect(store.working().goal).toBe("safe replacement");
});
