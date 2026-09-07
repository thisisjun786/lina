import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ConversationStore,
	type PreferenceProposal,
	type UserSource,
} from "../src/agents/conversation.ts";
import { entry, Fixture } from "./fixture.ts";

describe("human conversation history", () => {
	let fixture: Fixture;
	beforeEach(() => {
		fixture = new Fixture();
	});
	afterEach(() => fixture.close());

	it("excludes machine turns but preserves legacy answers, notices and final thinking plus text", () => {
		const store = fixture.store();
		const code = "Here is the result:\n```ts\nconst answer = 42;\n```";
		const hidden = [
			entry("tool", { role: "tool" }),
			entry("meta", { role: "meta" }),
			entry("empty", { text: "" }),
			entry("blank", { text: " \t\r\n" }),
			entry("tool-use", { raw: { message: { stopReason: "toolUse" } } }),
			entry("tool-call", {
				raw: {
					message: {
						content: [
							{ type: "text", text: "Working" },
							{ type: "toolCall", name: "read" },
						],
					},
				},
			}),
			entry("phase", { raw: { message: { phase: "commentary" } } }),
			entry("signature", {
				raw: {
					message: {
						phase: null,
						stopReason: "stop",
						content: [
							{ type: "thinking" },
							{
								type: "text",
								textSignature: '{"phase":"commentary","id":"m1"}',
							},
						],
					},
				},
			}),
		];
		const visible = [
			entry("user", {
				role: "user",
				raw: { message: { phase: "commentary", stopReason: "toolUse" } },
			}),
			entry("legacy", {
				raw: {
					message: {
						role: "assistant",
						phase: null,
						content: [{ type: "text", text: "message legacy" }],
					},
				},
			}),
			entry("notice", {
				raw: { type: "custom_message", customType: "lina.development" },
			}),
			entry("final", {
				text: code,
				raw: {
					message: {
						phase: null,
						stopReason: "stop",
						content: [
							{ type: "thinking", thinking: "private reasoning" },
							{
								type: "text",
								text: code,
								textSignature: '{"phase":"final_answer"}',
							},
						],
					},
				},
			}),
		];
		for (const source of [...hidden, ...visible]) store.appendEntry(source);
		const rawHistory = store.history();
		const rawSearch = store.search("message");
		const revision = store.revision();
		const page = store.conversationHistory();
		expect(page.messages.map((row) => row.entryId)).toEqual([
			"user",
			"legacy",
			"notice",
			"final",
		]);
		expect(page.messages.at(-1)?.text).toBe(code);
		expect(page.hasEarlier).toBe(false);
		expect(JSON.stringify(page)).not.toContain("private reasoning");
		expect(store.history()).toEqual(rawHistory);
		expect(store.search("message")).toEqual(rawSearch);
		expect(rawHistory.messages.map((row) => row.entryId)).toContain("tool-use");
		expect(rawSearch.messages.map((row) => row.entryId)).toContain("tool-call");
		for (const source of [...hidden, ...visible])
			expect(store.entry(source.entryId)).toEqual(source);
		expect(store.revision()).toBe(revision);
	});

	it("filters before LIMIT across more than 100 hidden rows and keeps raw seq cursors stable", () => {
		const store = fixture.store();
		for (const name of ["oldest", "middle", "newest"]) {
			for (let i = 0; i < 125; i++) {
				store.appendEntry(
					entry(
						`${name}-hidden-${i}`,
						i % 2
							? { role: "tool" }
							: { raw: { message: { stopReason: "toolUse" } } },
					),
				);
			}
			store.appendEntry(entry(name));
		}
		for (let i = 0; i < 125; i++)
			store.appendEntry(entry(`tail-${i}`, { role: "meta" }));
		const page = store.conversationHistory({ limit: 2 });
		expect(page.messages.map((row) => [row.entryId, row.seq])).toEqual([
			["middle", 252],
			["newest", 378],
		]);
		expect(page.beforeCursor).toBe(252);
		expect(page.hasEarlier).toBe(true);
		store.appendEntry(entry("new-append"));
		const older = store.conversationHistory({ before: 252, limit: 1 });
		expect(older.messages.map((row) => [row.entryId, row.seq])).toEqual([
			["oldest", 126],
		]);
		expect(older.beforeCursor).toBe(126);
		expect(older.hasEarlier).toBe(false);
		expect(store.conversationHistory({ before: 126 })).toEqual({
			messages: [],
			hasEarlier: false,
			beforeCursor: null,
		});
		expect(
			store.conversationHistory({ before: 377, limit: 1 }).messages[0]?.entryId,
		).toBe("middle");
	});

	it("shares history defaults, bounds, preview limits and invalid argument rejection", () => {
		const store = fixture.store();
		expect(store.conversationHistory()).toEqual({
			messages: [],
			hasEarlier: false,
			beforeCursor: null,
		});
		for (let i = 0; i < 205; i++) store.appendEntry(entry(`human-${i}`));
		store.appendEntry(entry("large", { text: "😀".repeat(4096) }));
		expect(store.conversationHistory().messages).toHaveLength(100);
		const bounded = store.conversationHistory({ limit: 10000 });
		expect(bounded.messages).toHaveLength(200);
		expect(bounded.hasEarlier).toBe(true);
		expect(bounded.messages.at(-1)).toMatchObject({
			text: "😀".repeat(2048),
			truncated: true,
		});
		expect(store.entry("large")?.text).toBe("😀".repeat(4096));
		for (const value of [
			0,
			-1,
			NaN,
			Infinity,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => store.conversationHistory({ before: value })).toThrow(
				"invalid history cursor",
			);
			expect(() => store.conversationHistory({ limit: value })).toThrow(
				"invalid history limit",
			);
		}
	});

	it("guards malformed native JSON, scalar content, and nested signature JSON", () => {
		const store = fixture.store();
		const rawValues: unknown[] = [
			null,
			"legacy",
			7,
			[],
			{ message: null },
			{ message: { content: "plain text" } },
			{ message: { content: { type: "toolCall" } } },
			{
				message: {
					content: [
						null,
						7,
						"not JSON",
						true,
						[],
						{ type: "text", textSignature: "not JSON" },
					],
				},
			},
			...[
				null,
				7,
				{},
				'{"phase":',
				'"commentary"',
				"[]",
				'{"other":{"phase":"commentary"}}',
			].map((textSignature) => ({
				message: { content: [{ type: "text", textSignature }] },
			})),
		];
		for (const [i, raw] of rawValues.entries())
			store.appendEntry(entry(`fallback-${i}`, { raw }));
		store.appendEntry(entry("corrupt"));
		const db = fixture.keep(new DatabaseSync(fixture.file));
		db.prepare("UPDATE entries SET raw_json = ? WHERE entry_id = ?").run(
			'{"message":',
			"corrupt",
		);
		const before = db
			.prepare("SELECT entry_id, text, raw_json FROM entries ORDER BY seq")
			.all();
		expect(
			store.conversationHistory().messages.map((row) => row.entryId),
		).toEqual([...rawValues.map((_, i) => `fallback-${i}`), "corrupt"]);
		expect(
			db
				.prepare("SELECT entry_id, text, raw_json FROM entries ORDER BY seq")
				.all(),
		).toEqual(before);
	});

	it("falls back compatibly when outer or signature JSON exceeds SQLite nesting limits", () => {
		const store = fixture.store();
		const nested = `${"[".repeat(1100)}0${"]".repeat(1100)}`;
		const sources = [
			entry("deep-raw", {
				raw: JSON.parse(`{"message":{"phase":"commentary"},"deep":${nested}}`),
			}),
			entry("deep-signature", {
				raw: {
					message: {
						content: [
							{
								type: "text",
								textSignature: `{"phase":"commentary","deep":${nested}}`,
							},
						],
					},
				},
			}),
		];
		for (const source of sources) store.appendEntry(source);
		const revision = store.revision();
		expect(
			store.conversationHistory().messages.map((row) => row.entryId),
		).toEqual(["deep-raw", "deep-signature"]);
		for (const source of sources)
			expect(store.entry(source.entryId)).toEqual(source);
		expect(store.revision()).toBe(revision);
	});
});

describe("bounded conversation store", () => {
	let dir: string;
	let store: ConversationStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-conversation-"));
		store = new ConversationStore(join(dir, "conversation.sqlite"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an in-memory default profile without creating profile rows", () => {
		expect(store.get("agent-1")).toEqual({
			revision: 0,
			style: "",
			examples: [],
		});
		const db = new DatabaseSync(join(dir, "conversation.sqlite"));
		expect(
			Reflect.get(
				db.prepare("SELECT COUNT(*) AS n FROM conversation_profiles").get() ??
					{},
				"n",
			),
		).toBe(0);
		db.close();
	});

	it("updates profiles with CAS and validates bounded examples", () => {
		const profile = store.update("agent-1", 0, {
			style: "Warm, concise replies.",
			examples: [{ situation: "A greeting", response: "Hello there." }],
		});
		expect(profile).toEqual({
			revision: 1,
			style: "Warm, concise replies.",
			examples: [{ situation: "A greeting", response: "Hello there." }],
		});
		expect(() => store.update("agent-1", 0, { style: "stale" })).toThrow(
			"stale profile revision",
		);
		expect(() =>
			store.update("agent-1", 1, {
				examples: new Array(7).fill({ situation: "x", response: "y" }),
			}),
		).toThrow();
		expect(store.update("agent-1", 1, { style: "", examples: [] })).toEqual({
			revision: 2,
			style: "",
			examples: [],
		});
	});

	it("accepts only exact, user-owned source quotes and is idempotent by request", () => {
		const source: UserSource = {
			entryId: "u1",
			text: "Please address me casually, no emoji.",
			role: "user",
		};
		const validSource = (entryId: string) =>
			entryId === source.entryId ? source : undefined;
		const proposals: PreferenceProposal[] = [
			{ dimension: "register", value: "casual", quote: "address me casually" },
			{ dimension: "emoji", value: "none", quote: "no emoji" },
		];
		expect(
			store.observePreferences(
				"agent-1",
				"req-1",
				"u1",
				source.text,
				proposals,
				validSource,
			),
		).toEqual({
			revision: 1,
			items: [
				{
					dimension: "emoji",
					value: "none",
					quote: "no emoji",
					sourceEntryId: "u1",
					requestId: "req-1",
				},
				{
					dimension: "register",
					value: "casual",
					quote: "address me casually",
					sourceEntryId: "u1",
					requestId: "req-1",
				},
			],
		});
		expect(
			store.observePreferences(
				"agent-1",
				"req-1",
				"u1",
				source.text,
				proposals,
				validSource,
			),
		).toEqual(store.getPreferences("agent-1"));
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-1",
				"u1",
				source.text,
				[
					{
						dimension: "register",
						value: "polite",
						quote: "address me casually",
					},
				],
				validSource,
			),
		).toThrow("request already used");
	});

	it("replaces axes immediately, rejects assistant or foreign evidence, and bounds proposals", () => {
		const source: UserSource = {
			entryId: "u1",
			text: "Please be brief.",
			role: "user",
		};
		const validSource = (entryId: string) =>
			entryId === "u1" ? source : undefined;
		store.observePreferences(
			"agent-1",
			"req-1",
			"u1",
			source.text,
			[{ dimension: "verbosity", value: "brief", quote: "be brief" }],
			validSource,
		);
		const correction: UserSource = {
			entryId: "u2",
			text: "Actually, detailed answers are better.",
			role: "user",
		};
		const allSource = (entryId: string) =>
			entryId === "u1" ? source : entryId === "u2" ? correction : undefined;
		expect(
			store.observePreferences(
				"agent-1",
				"req-2",
				"u2",
				correction.text,
				[
					{
						dimension: "verbosity",
						value: "detailed",
						quote: "detailed answers",
					},
				],
				allSource,
			).items,
		).toEqual([
			{
				dimension: "verbosity",
				value: "detailed",
				quote: "detailed answers",
				sourceEntryId: "u2",
				requestId: "req-2",
			},
		]);
		const assistant = {
			entryId: "a1",
			text: "Be casual.",
			role: "assistant",
		} as unknown as UserSource;
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-3",
				"a1",
				assistant.text,
				[{ dimension: "register", value: "casual", quote: "Be casual." }],
				() => assistant,
			),
		).toThrow("user source");
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-4",
				"u2",
				correction.text,
				new Array(7).fill({
					dimension: "register",
					value: "casual",
					quote: "Actually",
				}),
				allSource,
			),
		).toThrow();
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-5",
				"u2",
				correction.text,
				[
					{
						dimension: "mood" as never,
						value: "casual" as never,
						quote: "Actually",
					},
				],
				allSource,
			),
		).toThrow("unknown preference dimension");
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-6",
				"u2",
				correction.text,
				[
					{
						dimension: "register",
						value: "unknown" as never,
						quote: "Actually",
					},
				],
				allSource,
			),
		).toThrow("unknown preference value");
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-7",
				"u2",
				correction.text,
				[{ dimension: "register", value: "casual", quote: "not present" }],
				allSource,
			),
		).toThrow("exact source substring");
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-8",
				"u2",
				correction.text,
				[{ dimension: "register", value: "casual", quote: "" }],
				allSource,
			),
		).toThrow("invalid preference quote");
		expect(() =>
			store.observePreferences(
				"agent-1",
				"req-9",
				"u2",
				correction.text,
				[{ dimension: "register", value: "casual", quote: "Actually" }],
				() => ({ entryId: "other", text: correction.text, role: "user" }),
			),
		).toThrow("invalid user source");
	});

	it("clears preferences with CAS and prevents old request replay", () => {
		const source: UserSource = {
			entryId: "u1",
			text: "Use brief replies.",
			role: "user",
		};
		const validSource = (entryId: string) =>
			entryId === "u1" ? source : undefined;
		store.observePreferences(
			"agent-1",
			"req-1",
			"u1",
			source.text,
			[{ dimension: "verbosity", value: "brief", quote: "brief replies" }],
			validSource,
		);
		expect(store.clearPreferences("agent-1", 1)).toEqual({
			revision: 2,
			items: [],
		});
		expect(() =>
			store.observePreferences(
				"agent-1",
				"slow-old",
				"u1",
				source.text,
				[{ dimension: "verbosity", value: "brief", quote: "brief replies" }],
				validSource,
				1,
			),
		).toThrow("stale preferences revision");
		expect(store.getPreferences("agent-1").revision).toBe(2);
		expect(() => store.clearPreferences("agent-1", 1)).toThrow(
			"stale preferences revision",
		);
		expect(
			store.observePreferences(
				"agent-1",
				"req-1",
				"u1",
				source.text,
				[{ dimension: "verbosity", value: "brief", quote: "brief replies" }],
				validSource,
			),
		).toEqual({ revision: 2, items: [] });
	});
});
