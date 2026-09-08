import { expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { nativePreferences } from "../src/persona/native-preferences.ts";
import {
	discloseNative,
	nativeEpisode,
} from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("N1: an unclassified intermediate assistant withholds the whole episode without preferences", async () => {
	const f = createRuntimeFixture(),
		m = new CompanionMemory({
			path: join(f.root, "whole.sqlite"),
			binding: f.runtime.binding,
			journal: f.store,
			schedule: () => () => {},
		});
	const seen: string[] = [];
	try {
		nativeEpisode(f.store, f.runtime.binding, "tainted");
		f.store.appendEntry({
			entryId: "unclassified-middle",
			role: "assistant",
			text: "unclassified middle",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {
				type: "message",
				message: { role: "assistant", stopReason: "toolUse" },
			},
		});
		f.store.appendSourceEntry(
			{
				entryId: "ordinary-final",
				role: "assistant",
				text: "tea",
				timestamp: "2026-09-08T00:00:00.000Z",
				raw: {
					type: "message",
					message: { role: "assistant", stopReason: "stop" },
				},
			},
			"tainted",
		);
		nativeEpisode(f.store, f.runtime.binding, "later");
		m.configure(async (prompt) => {
			seen.push(prompt);
			return "[]";
		});
		await m.refresh();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("later-user");
		expect(m.mind.hasReceipt("tainted-user")).toBe(false);
		expect(m.mind.hasReceipt("later-user")).toBe(true);
		expect(m.detail().processing.withheld).toBe(1);
	} finally {
		await m.close();
		await f.close();
	}
});

test("N1: complete ordinary intermediate ancestry persists and a done queue job rechecks it after reopen", async () => {
	const f = createRuntimeFixture(),
		options = {
			path: join(f.root, "whole-reopen.sqlite"),
			binding: f.runtime.binding,
			journal: f.store,
			schedule: () => () => {},
		};
	let m = new CompanionMemory(options),
		calls = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		f.store.appendSourceEntry(
			{
				entryId: "ordinary-middle",
				role: "assistant",
				text: "middle",
				timestamp: "2026-09-08T00:00:00.000Z",
				raw: {
					type: "message",
					message: { role: "assistant", stopReason: "toolUse" },
				},
			},
			"ordinary",
		);
		f.store.appendSourceEntry(
			{
				entryId: "ordinary-final",
				role: "assistant",
				text: "tea",
				timestamp: "2026-09-08T00:00:00.000Z",
				raw: {
					type: "message",
					message: { role: "assistant", stopReason: "stop" },
				},
			},
			"ordinary",
		);
		m.configure(async () => {
			calls++;
			return JSON.stringify([
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "tea",
					evidence: "explicit",
					sources: [{ entryId: "ordinary-user", quote: "tea" }],
				},
			]);
		});
		await m.refresh();
		expect(
			m.mind
				.state()
				.records[0]?.sourceProofs?.map((p) => p.entryId)
				.sort(),
		).toEqual([
			"ordinary-assistant",
			"ordinary-final",
			"ordinary-middle",
			"ordinary-user",
		]);
		await m.close();
		f.store.appendEntry({
			entryId: "late-unclassified",
			role: "assistant",
			text: "unclassified",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		});
		m = new CompanionMemory(options);
		m.configure(async () => {
			calls++;
			return "[]";
		});
		await m.refresh();
		expect(calls).toBe(1);
		expect(m.detail().processing.withheld).toBe(1);
	} finally {
		await m.close();
		await f.close();
	}
});

test("observer dispatch checks the frozen known-slot ancestry after an adapter await", async () => {
	const f = createRuntimeFixture(),
		m = new CompanionMemory({
			path: join(f.root, "dispatch.sqlite"),
			binding: f.runtime.binding,
			journal: f.store,
			schedule: () => () => {},
		});
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let dispatches = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "seed");
		m.configure(async () =>
			JSON.stringify([
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "tea",
					evidence: "explicit",
					sources: [{ entryId: "seed-user", quote: "tea" }],
				},
			]),
		);
		await m.refresh();
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		m.configure(async (prompt, _signal, beforeDispatch?: () => void) => {
			expect(prompt).toContain('"key":"drink"');
			started.resolve();
			await release.promise;
			beforeDispatch?.();
			dispatches++;
			return "[]";
		});
		const run = m.refresh();
		await started.promise;
		discloseNative(f.store, "seed");
		release.resolve();
		await run;
		expect(dispatches).toBe(0);
		expect(f.store.requestSourcePolicy("fresh")?.scope).toBe("ordinary");
		expect(m.mind.hasReceipt("fresh-user")).toBe(false);
	} finally {
		release.resolve();
		await m.close();
		await f.close();
	}
});

test("mixed episodes never dispatch, while later ordinary user and assistant evidence learns and reopens", async () => {
	const f = createRuntimeFixture();
	const options = {
		path: join(f.root, "memory.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	};
	let m = new CompanionMemory(options);
	const calls: string[] = [];
	try {
		nativeEpisode(f.store, f.runtime.binding, "mixed", true);
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		m.configure(async (prompt) => {
			calls.push(prompt);
			return JSON.stringify([
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "tea",
					evidence: "explicit",
					sources: [{ entryId: "ordinary-user", quote: "tea" }],
				},
			]);
		});
		await m.refresh();
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("mixed-user");
		expect(m.mind.state().records[0]?.text).toBe("tea");
		expect(m.detail().processing).toMatchObject({ withheld: 1, changed: 1 });
		await m.close();
		m = new CompanionMemory(options);
		await m.refresh();
		expect(
			m.mind
				.state()
				.records[0]?.sourceProofs?.map((p) => p.entryId)
				.sort(),
		).toEqual(["ordinary-assistant", "ordinary-user"]);
	} finally {
		await m.close();
		await f.close();
	}
});
test("policy changes during observer await leave history and no promoted receipt", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "memory.sqlite");
	const m = new CompanionMemory({
		path,
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	});
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	try {
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		m.configure(async () => {
			started.resolve();
			return release.promise;
		});
		const run = m.refresh();
		await started.promise;
		discloseNative(f.store, "ordinary");
		release.resolve("[]");
		await run;
		expect(m.mind.hasReceipt("ordinary-user")).toBe(false);
		expect(m.detail().processing).toMatchObject({
			withheld: 1,
			changed: 0,
			unchanged: 0,
		});
		const db = new DatabaseSync(`${path}.queue`);
		try {
			expect(
				db.prepare("SELECT state,attempts FROM companion_jobs").get(),
			).toEqual({ state: "withheld", attempts: 1 });
			expect(
				db.prepare("SELECT count(*) n FROM companion_history").get()?.["n"],
			).toBe(2);
		} finally {
			db.close();
		}
	} finally {
		release.resolve("[]");
		await m.close();
		await f.close();
	}
});

test("a done receipt with stale known-slot ancestry is withheld before redispatch", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "ancestry.sqlite");
	const options = {
		path,
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	};
	let m = new CompanionMemory(options),
		calls = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "first");
		m.configure(async () => {
			calls++;
			return JSON.stringify([
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "old-reference",
					evidence: "explicit",
					sources: [{ entryId: "first-user", quote: "tea" }],
				},
			]);
		});
		await m.refresh();
		nativeEpisode(f.store, f.runtime.binding, "second");
		m.configure(async (prompt) => {
			calls++;
			expect(prompt).toContain("old-reference");
			return "[]";
		});
		await m.refresh();
		expect(calls).toBe(2);
		discloseNative(f.store, "first");
		await m.close();
		m = new CompanionMemory(options);
		m.configure(async () => {
			calls++;
			return "[]";
		});
		await m.refresh();
		expect(calls).toBe(2);
		expect(m.detail().processing).toMatchObject({
			withheld: 2,
			changed: 0,
			unchanged: 0,
		});
		expect(m.mind.hasReceipt("second-user")).toBe(false);
		nativeEpisode(f.store, f.runtime.binding, "third");
		m.configure(async (prompt) => {
			calls++;
			expect(prompt).not.toContain("old-reference");
			return "[]";
		});
		await m.refresh();
		expect(calls).toBe(3);
		expect(m.mind.hasReceipt("third-user")).toBe(true);
	} finally {
		await m.close();
		await f.close();
	}
});

test("real Companion preference and memory receipts reopen together and revoke complete prompt ancestry", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "combined.sqlite"),
		preferencesPath = join(f.root, "preferences.sqlite");
	const options = {
		path,
		binding: f.runtime.binding,
		journal: f.store,
		schedule: () => () => {},
	};
	let m = new CompanionMemory(options),
		s = new ConversationStore(preferencesPath),
		calls = 0;
	const configure = () =>
		m.configure(
			async (_text, _signal, beforeDispatch) => {
				expect(typeof beforeDispatch).toBe("function");
				beforeDispatch?.();
				calls++;
				return JSON.stringify([
					{
						subject: "user",
						kind: "preference",
						key: "drink",
						text: "tea",
						evidence: "explicit",
						sources: [{ entryId: "ordinary-user", quote: "tea" }],
					},
				]);
			},
			nativePreferences(
				s,
				"lina",
				f.store,
				async (_text, _signal, beforeDispatch) => {
					expect(typeof beforeDispatch).toBe("function");
					beforeDispatch?.();
					calls++;
					return JSON.stringify({
						communicationPreferences: [
							{ dimension: "verbosity", value: "brief", quote: "tea" },
						],
					});
				},
			),
		);
	try {
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		configure();
		await m.refresh();
		expect(calls).toBe(2);
		const lookup = (id: string) => f.store.sourceEntry(id);
		expect(s.modelPreferences("lina", lookup).items[0]?.value).toBe("brief");
		expect(m.mind.recall("tea")).toHaveLength(1);
		const recall = await m.recall("tea");
		expect(m.recallSourceProofs(recall)).toHaveLength(2);
		await m.close();
		s.close();
		m = new CompanionMemory(options);
		s = new ConversationStore(preferencesPath);
		configure();
		await m.refresh();
		expect(calls).toBe(2);
		expect(
			s
				.modelPreferences("lina", lookup)
				.sourceProofs.map((p) => p.entryId)
				.sort(),
		).toEqual(["ordinary-assistant", "ordinary-user"]);
		discloseNative(f.store, "ordinary");
		await m.refresh();
		expect(calls).toBe(2);
		expect(m.mind.recall("tea")).toEqual([]);
		expect(m.recallSourceProofs(recall)).toBeUndefined();
		expect(s.modelPreferences("lina", lookup).items).toEqual([]);
		expect(s.getPreferences("lina").items).toHaveLength(1);
		expect(m.detail().processing.withheld).toBe(1);
	} finally {
		await m.close();
		s.close();
		await f.close();
	}
});
