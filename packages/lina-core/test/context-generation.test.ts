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
