import { expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContextStore } from "../src/context/store.ts";
import { appendContextEntry } from "./context-journal-fixture.ts";
import { entry, Fixture } from "./fixture.ts";

test("summary generation reuses exact current evidence across file reopen and rejects tampering", () => {
	const f = new Fixture(),
		journal = f.store(),
		path = join(f.dir, "context.sqlite");
	appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("source", { role: "user" }),
	);
	let store = new ContextStore(path, f.binding, (id) =>
		journal.sourceEntry(id),
	);
	const sources = [{ kind: "entry" as const, id: "source" }],
		generation = {
			version: 1 as const,
			policyDigest: "a".repeat(64),
			routeKey: "model1",
			estimatorId: "bytes",
			inputDigest: "b".repeat(64),
		};
	try {
		const node = store.stage({
			text: "summary",
			kind: "model",
			sources,
			generation,
		});
		expect(node.generation).toEqual(generation);
		store.close();
		store = new ContextStore(path, f.binding, (id) => journal.sourceEntry(id));
		expect(store.findGenerated(sources, generation)).toEqual(node);
		expect(
			store.findGenerated(sources, { ...generation, routeKey: "other" }),
		).toBeUndefined();
		store.close();
		const db = new DatabaseSync(path);
		db.prepare("UPDATE summary_generations SET generation_json=?").run(
			JSON.stringify({ ...generation, routeKey: "tampered" }),
		);
		db.close();
		expect(
			() => new ContextStore(path, f.binding, (id) => journal.sourceEntry(id)),
		).toThrow();
	} finally {
		store.close();
		f.close();
	}
});

test.each([false, true])(
	"v2 generation migration preserves legacy bytes and rolls back corrupt originals: %s",
	(corrupt) => {
		const f = new Fixture(),
			journal = f.store(),
			path = join(f.dir, "migration.sqlite");
		appendContextEntry(
			journal,
			f.binding.sessionId,
			entry("source", { role: "user" }),
		);
		const initial = new ContextStore(path, f.binding, (id) =>
			journal.sourceEntry(id),
		);
		const node = initial.stage({
			text: "Original checkpoint",
			kind: "model",
			sources: [{ kind: "entry", id: "source" }],
		});
		initial.activate({
			id: node.id,
			nativeEntryId: `external:${node.id}`,
			firstKeptEntryId: "source",
			expectedActiveId: null,
		});
		initial.close();
		const db = new DatabaseSync(path);
		db.exec(
			"DROP TABLE summary_generations; UPDATE context_meta SET value='2' WHERE key='schema_version'; PRAGMA user_version=2",
		);
		if (corrupt) db.exec("UPDATE summaries SET text='corrupt checkpoint'");
		const rows = db.prepare("SELECT * FROM summaries").all();
		db.close();
		try {
			if (corrupt) {
				expect(
					() =>
						new ContextStore(path, f.binding, (id) => journal.sourceEntry(id)),
				).toThrow();
			} else {
				const restored = new ContextStore(path, f.binding, (id) =>
					journal.sourceEntry(id),
				);
				expect(restored.get(node.id)).toEqual(node);
				expect(restored.active()?.id).toBe(node.id);
				restored.close();
			}
			const check = new DatabaseSync(path);
			expect(check.prepare("SELECT * FROM summaries").all()).toEqual(rows);
			expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
				corrupt ? 2 : 3,
			);
			expect(
				!!check
					.prepare(
						"SELECT name FROM sqlite_schema WHERE name='summary_generations'",
					)
					.get(),
			).toBe(!corrupt);
			check.close();
		} finally {
			f.close();
		}
	},
);

test("explicit null generation cannot downgrade a new summary to legacy provenance", () => {
	const f = new Fixture(),
		journal = f.store();
	appendContextEntry(
		journal,
		f.binding.sessionId,
		entry("source", { role: "user" }),
	);
	const store = new ContextStore(join(f.dir, "null.sqlite"), f.binding, (id) =>
		journal.sourceEntry(id),
	);
	try {
		const input = JSON.parse(
			'{"kind":"model","text":"bad","sources":[{"kind":"entry","id":"source"}],"generation":null}',
		);
		expect(() => store.stage(input)).toThrow(/generation/);
	} finally {
		store.close();
		f.close();
	}
});
