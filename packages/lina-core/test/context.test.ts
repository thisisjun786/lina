import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveText } from "../src/context/archive.ts";
import { ContextStore } from "../src/context/store.ts";
import type { SourceRef } from "../src/context/types.ts";
import type { DurableStore } from "../src/store.ts";
import { appendContextEntry } from "./context-journal-fixture.ts";
import { entry, Fixture } from "./fixture.ts";

function native(id: string, role: string, content: unknown) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-05T00:00:00.000Z",
		message: { role, content },
	};
}

describe("context store", () => {
	let fixture: Fixture;
	let durable: DurableStore;
	let file: string;
	const open = () =>
		fixture.keep(
			new ContextStore(file, fixture.binding, (id) => durable.sourceEntry(id), {
				lookupRequest: (id) =>
					durable.sourceEntry(durable.request(id)?.entryId ?? ""),
			}),
		);
	beforeEach(() => {
		fixture = new Fixture();
		durable = fixture.store();
		file = join(fixture.dir, "context.sqlite");
		for (let i = 1; i <= 70; i++)
			appendContextEntry(
				durable,
				fixture.binding.sessionId,
				entry(`e${i}`, { role: i % 2 ? "user" : "assistant" }),
			);
	});
	afterEach(() => fixture.close());

	it("stages immutable nodes with code-generated IDs and rejects unknown or cyclic references", () => {
		const store = open();
		const leaf = store.stage({
			text: "leaf",
			kind: "model",
			sources: [
				{ kind: "entry", id: "e1" },
				{ kind: "entry", id: "e2" },
			],
		});
		expect(leaf.depth).toBe(0);
		expect(leaf.id).toMatch(/^summary-[0-9a-f]{32}$/);
		expect(store.get(leaf.id)).toEqual(leaf);
		expect(store.get("missing")).toBeUndefined();
		// Replay of identical content returns the same node; a change is a new node.
		expect(
			store.stage({ text: "leaf", kind: "model", sources: leaf.sources }),
		).toEqual(leaf);
		expect(
			store.stage({ text: "leaf", kind: "extractive", sources: leaf.sources })
				.id,
		).not.toBe(leaf.id);
		const root = store.stage({
			text: "root",
			kind: "extractive",
			sources: [
				{ kind: "summary", id: leaf.id },
				{ kind: "entry", id: "e3" },
			],
		});
		expect(root.depth).toBe(1);
		const bad: [string, Parameters<typeof store.stage>[0]][] = [
			[
				"entry",
				{ text: "x", kind: "model", sources: [{ kind: "entry", id: "nope" }] },
			],
			[
				"summary",
				{
					text: "x",
					kind: "model",
					sources: [{ kind: "summary", id: "summary-nope" }],
				},
			],
			["source", { text: "x", kind: "model", sources: [] }],
			[
				"kind",
				{
					text: "x",
					kind: "model",
					sources: [{ kind: "file" as "entry", id: "e1" }],
				},
			],
			[
				"unique",
				{
					text: "x",
					kind: "model",
					sources: [
						{ kind: "entry", id: "e1" },
						{ kind: "entry", id: "e1" },
					],
				},
			],
			[
				"blank",
				{ text: "  ", kind: "model", sources: [{ kind: "entry", id: "e1" }] },
			],
			[
				"8192",
				{
					text: "x".repeat(8193),
					kind: "model",
					sources: [{ kind: "entry", id: "e1" }],
				},
			],
			[
				"64",
				{
					text: "x",
					kind: "model",
					sources: Array.from({ length: 65 }, (_, i) => ({
						kind: "entry" as const,
						id: `e${i + 1}`,
					})),
				},
			],
			[
				"summary kind",
				{
					text: "x",
					kind: "prose" as "model",
					sources: [{ kind: "entry", id: "e1" }],
				},
			],
		];
		for (const [pattern, input] of bad)
			expect(() => store.stage(input), pattern).toThrow(new RegExp(pattern));
		// A staged ID can only reference already-committed parents, so a self edge is unknown.
		const wouldBeId = `summary-${"0".repeat(32)}`;
		expect(() =>
			store.stage({
				text: "cycle",
				kind: "model",
				sources: [{ kind: "summary", id: wouldBeId }],
			}),
		).toThrow(/unknown source summary/);
		expect(
			store.stage({
				text: "wide",
				kind: "model",
				sources: Array.from({ length: 64 }, (_, i) => ({
					kind: "entry" as const,
					id: `e${i + 1}`,
				})),
			}).sources,
		).toHaveLength(64);
	});

	it("tracks depth beyond 32 levels and survives reopen", () => {
		let store = open();
		let parent: SourceRef = { kind: "entry", id: "e1" };
		let last = store.stage({ text: "d0", kind: "model", sources: [parent] });
		for (let depth = 1; depth <= 40; depth++) {
			parent = { kind: "summary", id: last.id };
			last = store.stage({
				text: `d${depth}`,
				kind: "model",
				sources: [parent],
			});
			expect(last.depth).toBe(depth);
		}
		store.close();
		expect(() => store.get(last.id)).toThrow(/closed/);
		store = open();
		expect(store.get(last.id)).toEqual(last);
		expect(store.expand({ kind: "summary", id: last.id }).sources).toEqual([
			{ kind: "summary", id: last.sources[0]?.id ?? "" },
		]);
	});

	it("activates with CAS on the active ID and idempotent native receipts", () => {
		let store = open();
		const a = store.stage({
			text: "a",
			kind: "model",
			sources: [{ kind: "entry", id: "e1" }],
		});
		const b = store.stage({
			text: "b",
			kind: "model",
			sources: [{ kind: "entry", id: "e2" }],
		});
		expect(store.active()).toBeNull();
		expect(() =>
			store.activate({
				id: "summary-missing",
				nativeEntryId: "n1",
				firstKeptEntryId: "e2",
				expectedActiveId: null,
			}),
		).toThrow(/unknown summary/);
		expect(() =>
			store.activate({
				id: a.id,
				nativeEntryId: "n1",
				firstKeptEntryId: "e2",
				expectedActiveId: b.id,
			}),
		).toThrow(/stale/);
		expect(store.active()).toBeNull();
		const first = store.activate({
			id: a.id,
			nativeEntryId: "n1",
			firstKeptEntryId: "e2",
			expectedActiveId: null,
		});
		expect(first).toEqual({
			id: a.id,
			nativeEntryId: "n1",
			firstKeptEntryId: "e2",
			revision: 1,
		});
		// Replay of the same receipt is idempotent regardless of expected ID.
		expect(
			store.activate({
				id: a.id,
				nativeEntryId: "n1",
				firstKeptEntryId: "e2",
				expectedActiveId: null,
			}),
		).toEqual(first);
		expect(
			store.activate({
				id: a.id,
				nativeEntryId: "n1",
				firstKeptEntryId: "e2",
				expectedActiveId: a.id,
			}),
		).toEqual(first);
		// Same node with a different receipt is a conflict, never a silent update.
		expect(() =>
			store.activate({
				id: a.id,
				nativeEntryId: "n2",
				firstKeptEntryId: "e2",
				expectedActiveId: a.id,
			}),
		).toThrow(/receipt conflict/);
		expect(() =>
			store.activate({
				id: b.id,
				nativeEntryId: "n2",
				firstKeptEntryId: "e3",
				expectedActiveId: null,
			}),
		).toThrow(/stale/);
		expect(store.active()).toEqual(first);
		const second = store.activate({
			id: b.id,
			nativeEntryId: "n2",
			firstKeptEntryId: "e3",
			expectedActiveId: a.id,
		});
		expect(second.revision).toBe(2);
		store.close();
		store = open();
		expect(store.active()).toEqual(second);
		expect(() =>
			store.activate({
				id: b.id,
				nativeEntryId: "",
				firstKeptEntryId: "e3",
				expectedActiveId: a.id,
			}),
		).toThrow(/invalid native entry id/);
	});

	it("replaces working state with optimistic concurrency and real user source IDs", () => {
		let store = open();
		const update = (
			revision: number,
			fields: Parameters<typeof store.updateWorking>[1],
		) =>
			store.updateWorking(revision, fields, { activeRequestId: "context-e1" });
		expect(store.working()).toEqual({
			revision: 0,
			goal: "",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		});
		const next = update(0, {
			goal: "ship context",
			decisions: ["use sqlite"],
			sourceEntryIds: ["e1", "e3"],
		});
		expect(next).toEqual({
			revision: 1,
			goal: "ship context",
			decisions: ["use sqlite"],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: ["e1", "e3"],
		});
		expect(() => update(0, { goal: "again" })).toThrow(
			/stale working revision/,
		);
		const bad: [RegExp, Parameters<typeof store.updateWorking>[1]][] = [
			[/1000/, { goal: "g".repeat(1001) }],
			[/8 items/, { decisions: Array.from({ length: 9 }, () => "d") }],
			[/300/, { openItems: ["o".repeat(301)] }],
			[/blank/, { nextSteps: [" "] }],
			[
				/8 references/,
				{
					sourceEntryIds: Array.from({ length: 9 }, (_, i) => `e${i * 2 + 1}`),
				},
			],
			[/not a user entry/, { sourceEntryIds: ["e2"] }],
			[/not a user entry/, { sourceEntryIds: ["missing"] }],
			[/unique/, { sourceEntryIds: ["e1", "e1"] }],
			[
				/unknown working field/,
				{ extra: 1 } as Parameters<typeof store.updateWorking>[1],
			],
			[/invalid working decisions/, { decisions: "x" as unknown as string[] }],
		];
		for (const [pattern, fields] of bad) {
			expect(
				() => update(1, { goal: "partial", ...fields }),
				String(pattern),
			).toThrow(pattern);
		}
		expect(store.working()).toEqual(next);
		expect(() => update(-1, {})).toThrow(/invalid working revision/);
		// Replacement, never append: an empty list clears.
		const cleared = update(1, {
			decisions: [],
			sourceEntryIds: [],
		});
		expect(cleared).toMatchObject({
			revision: 2,
			decisions: [],
			sourceEntryIds: [],
			goal: "ship context",
		});
		store.close();
		store = open();
		expect(store.working()).toEqual(cleared);
	});

	it("expands one level with bounded text and source pages that reach tool-only originals", () => {
		const store = open();
		const long = "가".repeat(5000);
		appendContextEntry(
			durable,
			fixture.binding.sessionId,
			entry("long", {
				text: long,
				raw: native("long", "user", [{ type: "text", text: long }]),
			}),
		);
		appendContextEntry(
			durable,
			fixture.binding.sessionId,
			entry("tool-only", {
				text: "",
				raw: native("tool-only", "assistant", [
					{ type: "thinking", thinking: "private", thinkingSignature: "sig" },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { cmd: "ls", cwd: "/" },
					},
				]),
			}),
		);
		appendContextEntry(
			durable,
			fixture.binding.sessionId,
			entry("image", {
				role: "user",
				text: "look",
				raw: native("image", "user", [
					{ type: "text", text: "look" },
					{ type: "image", mimeType: "image/png", data: "A".repeat(10000) },
				]),
			}),
		);
		const first = store.expand({ kind: "entry", id: "long" });
		expect(first.text).toBe("가".repeat(4096));
		expect(first).toMatchObject({
			ref: { kind: "entry", id: "long" },
			nextOffset: 4096,
			sources: [],
			nextSourceOffset: null,
		});
		if (first.nextOffset === null) throw new Error("expected next page");
		const rest = store.expand(
			{ kind: "entry", id: "long" },
			{ offset: first.nextOffset },
		);
		expect(rest.text).toBe("가".repeat(904));
		expect(rest.nextOffset).toBeNull();
		const tool = store.expand({ kind: "entry", id: "tool-only" });
		expect(tool.text).toBe('[tool call bash] {"cmd":"ls","cwd":"/"}');
		expect(tool.text).not.toContain("private");
		expect(tool.text).not.toContain("sig");
		const image = store.expand({ kind: "entry", id: "image" });
		expect(image.text).toBe(
			"look\n\n[attachment image/png base64-chars=10000]",
		);
		expect(image.text).not.toContain("AAAA");

		const sources = Array.from({ length: 40 }, (_, i) => ({
			kind: "entry" as const,
			id: `e${i + 1}`,
		}));
		const wide = store.stage({
			text: "w".repeat(8192),
			kind: "model",
			sources,
		});
		const parent = store.stage({
			text: "p",
			kind: "model",
			sources: [{ kind: "summary", id: wide.id }],
		});
		const page1 = store.expand({ kind: "summary", id: wide.id });
		expect(page1.text).toHaveLength(4096);
		expect(page1.nextOffset).toBe(4096);
		expect(page1.sources).toEqual(sources.slice(0, 16));
		expect(page1.nextSourceOffset).toBe(16);
		const page2 = store.expand(
			{ kind: "summary", id: wide.id },
			{ offset: 4096, sourceOffset: 16 },
		);
		expect(page2.text).toHaveLength(4096);
		expect(page2.nextOffset).toBeNull();
		expect(page2.sources).toEqual(sources.slice(16, 32));
		const page3 = store.expand(
			{ kind: "summary", id: wide.id },
			{ offset: 8192, sourceOffset: 32 },
		);
		expect(page3).toEqual({
			ref: { kind: "summary", id: wide.id },
			text: "",
			nextOffset: null,
			sources: sources.slice(32),
			nextSourceOffset: null,
		});
		// One level only: the parent lists the child summary, never its entries.
		expect(store.expand({ kind: "summary", id: parent.id }).sources).toEqual([
			{ kind: "summary", id: wide.id },
		]);
		expect(() =>
			store.expand({ kind: "summary", id: wide.id }, { offset: 9000 }),
		).toThrow(/invalid expand offset/);
		expect(() =>
			store.expand({ kind: "summary", id: wide.id }, { sourceOffset: 41 }),
		).toThrow(/sourceOffset/);
		expect(() =>
			store.expand({ kind: "entry", id: "long" }, { sourceOffset: 1 }),
		).toThrow(/sourceOffset/);
		expect(() =>
			store.expand({ kind: "entry", id: "long" }, { offset: -1 }),
		).toThrow(/invalid expand offset/);
		expect(() =>
			store.expand({ kind: "entry", id: "long" }, { offset: 1.5 }),
		).toThrow(/invalid expand offset/);
		expect(() => store.expand({ kind: "entry", id: "nope" })).toThrow(
			/unknown source entry/,
		);
		expect(() => store.expand({ kind: "summary", id: "nope" })).toThrow(
			/unknown source summary/,
		);
	});

	it("rejects foreign, unknown, corrupt and unsafe stores", () => {
		const store = open();
		store.stage({
			text: "a",
			kind: "model",
			sources: [{ kind: "entry", id: "e1" }],
		});
		store.close();
		const foreign = { ...fixture.binding, sessionId: "other" };
		expect(() => new ContextStore(file, foreign, () => undefined)).toThrow(
			/foreign context store binding/,
		);
		expect(
			() => new ContextStore(fixture.file, fixture.binding, () => undefined),
		).toThrow(/unknown context store schema/);
		const link = join(fixture.dir, "link.sqlite");
		symlinkSync(file, link);
		expect(
			() => new ContextStore(link, fixture.binding, () => undefined),
		).toThrow(/unsafe regular file/);
		const garbage = join(fixture.dir, "garbage.sqlite");
		writeFileSync(garbage, "not a database");
		expect(
			() => new ContextStore(garbage, fixture.binding, () => undefined),
		).toThrow();
		const corrupt = new DatabaseSync(file);
		corrupt.exec("DELETE FROM working_state");
		corrupt.close();
		expect(() => open()).toThrow(/corrupt context working state/);
		expect(
			() =>
				new ContextStore(
					join(fixture.dir, "fresh.sqlite"),
					fixture.binding,
					undefined as unknown as () => undefined,
				),
		).toThrow(/invalid entry lookup/);
	});
});

describe("archive projection", () => {
	it("keeps visible text, tool calls, results and attachments while dropping private content", () => {
		const assistant = entry("a", {
			raw: native("a", "assistant", [
				{ type: "thinking", thinking: "secret plan", thinkingSignature: "sig" },
				{ type: "text", text: "Answer" },
				{
					type: "toolCall",
					id: "c",
					name: "read",
					arguments: { z: 1, a: [2] },
				},
			]),
		});
		expect(archiveText(assistant)).toBe(
			'Answer\n\n[tool call read] {"a":[2],"z":1}',
		);
		const result = entry("r", {
			role: "tool",
			text: "",
			raw: {
				...native("r", "toolResult", [
					{ type: "text", text: "output" },
					{ type: "image", mimeType: "image/jpeg", data: "xyz" },
				]),
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "c",
					isError: true,
					content: [
						{ type: "text", text: "output" },
						{ type: "image", mimeType: "image/jpeg", data: "xyz" },
					],
				},
			},
		});
		expect(archiveText(result)).toBe(
			"[tool result read error]\n\noutput\n\n[attachment image/jpeg base64-chars=3]",
		);
		expect(
			archiveText(
				entry("bash", {
					raw: {
						message: { role: "bashExecution", command: "ls", output: "a\nb" },
					},
				}),
			),
		).toBe("[bash] ls\n\na\nb");
		expect(
			archiveText(
				entry("sum", {
					raw: { message: { role: "compactionSummary", summary: "S" } },
				}),
			),
		).toBe("S");
		expect(
			archiveText(
				entry("legacy", {
					role: "meta",
					text: "",
					raw: {
						type: "compaction",
						id: "legacy",
						summary: "Legacy summary",
						firstKeptEntryId: "k",
						details: { thinking: "x" },
					},
				}),
			),
		).toBe("Legacy summary");
		expect(
			archiveText(
				entry("branch", {
					role: "meta",
					text: "",
					raw: { type: "branch_summary", summary: "B" },
				}),
			),
		).toBe("B");
		expect(
			archiveText(
				entry("plain", { text: "fallback", raw: { noMessage: true } }),
			),
		).toBe("fallback");
		expect(
			archiveText(
				entry("empty", {
					text: "fallback",
					raw: native("empty", "assistant", [
						{ type: "thinking", thinking: "x" },
					]),
				}),
			),
		).toBe("fallback");
		expect(
			archiveText(
				entry("str", {
					text: "",
					raw: native("str", "user", "plain string content"),
				}),
			),
		).toBe("plain string content");
	});
});
