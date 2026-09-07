import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compilePersona } from "../src/agents/persona.ts";
import { AgentStore } from "../src/agents/store.ts";
import type { AgentInput } from "../src/agents/types.ts";

const input = (patch: Partial<AgentInput> = {}): AgentInput => ({
	id: "lina",
	name: "Lina",
	role: "assistant",
	personality: "curious",
	voice: "warm",
	profile: "core lore",
	appearance: "silver eyes",
	interests: ["music"],
	avatarId: null,
	evolution: "adaptive",
	...patch,
});

describe("agent registry and bounded dynamics", () => {
	let dir: string;
	let store: AgentStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-agents-"));
		store = new AgentStore(join(dir, "agents.sqlite"), () => 1_700_000_000_000);
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("relationship growth needs separate conversations and empty proposals preserve experience", () => {
		store.create(input());
		const reflect = (requestId: string, relationship: string[]) =>
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: store.dynamics("lina").revision,
					requestId,
					sourceEntryIds: [requestId],
					relationship,
				},
				() => true,
			);
		expect(
			reflect("one", ["comfortable discussing music"]).relationship,
		).toEqual([]);
		expect(
			reflect("two", ["comfortable discussing music"]).relationship,
		).toEqual(["comfortable discussing music"]);
		expect(reflect("three", []).relationship).toEqual([
			"comfortable discussing music",
		]);
	});

	it("confirmed interests keep evolving when the bounded list is full", () => {
		store.create(input());
		let turn = 0;
		const reflect = (interests: string[]) =>
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: store.dynamics("lina").revision,
					requestId: `growth-${++turn}`,
					sourceEntryIds: [`source-${turn}`],
					interests,
				},
				() => true,
			);
		const initial = Array.from({ length: 16 }, (_, i) => `interest ${i}`);
		reflect(initial);
		reflect(initial);
		expect(reflect(["new interest"]).interests).toEqual(initial);
		expect(reflect(["new interest"]).interests).toEqual([
			...initial.slice(1),
			"new interest",
		]);
	});

	it("provisional interests are available separately and never become established state on one turn", () => {
		store.create(input());
		store.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "proposal",
				sourceEntryIds: ["user"],
				interests: ["jazz"],
			},
			() => true,
		);
		expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
		expect(store.dynamics("lina").interests).toEqual([]);
		store.update("lina", 1, { voice: "new voice" });
		expect(store.pendingGrowth("lina").interests).toEqual([]);
	});

	it("creates, lists, updates with CAS, and persists", () => {
		const created = store.create(input());
		expect(created.revision).toBe(1);
		expect(store.list()).toEqual([created]);
		const updated = store.update("lina", 1, { voice: "quiet" });
		expect(updated).toMatchObject({ voice: "quiet", revision: 2 });
		expect(() => store.update("lina", 1, { role: "stale" })).toThrow(
			/revision/i,
		);
		store.close();
		store = new AgentStore(join(dir, "agents.sqlite"));
		expect(store.get("lina")).toMatchObject({ voice: "quiet", revision: 2 });
	});

	it("applies sourced reflections once, expires mood, and records changes", () => {
		store.create(input());
		const reflection = {
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "req-1",
			sourceEntryIds: ["entry-1"],
			mood: { label: "bright", reason: "helpful exchange" },
			preferences: ["concise answers"],
		};
		const dynamics = store.applyReflection(
			"lina",
			reflection,
			(id) => id === "entry-1",
		);
		expect(dynamics).toMatchObject({ revision: 1, lastRequestId: "req-1" });
		expect(
			store.applyReflection(
				"lina",
				{ ...reflection, dynamicsRevision: 1 },
				() => true,
			),
		).toEqual(dynamics);
		expect(store.changes("lina")).toHaveLength(1);
		expect(store.dynamics("lina").mood?.expiresAt).toBe(
			1_700_000_000_000 + 4 * 60 * 60 * 1000,
		);
	});

	it("keeps reflection immutable for manual personas and rejects invalid sources", () => {
		store.create(input({ evolution: "manual" }));
		expect(
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: "req-1",
					sourceEntryIds: ["missing"],
				},
				() => false,
			),
		).toEqual(store.dynamics("lina"));
		expect(store.changes("lina")).toEqual([]);
		store.update("lina", 1, { name: "Lina 2" });
		expect(() =>
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: "req-2",
					sourceEntryIds: ["entry"],
				},
				() => true,
			),
		).toThrow(/profile revision/i);
	});

	it("reverts a reflection through a dynamics CAS and blocks receipt replay", () => {
		store.create(input());
		store.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "req-1",
				sourceEntryIds: ["e"],
				interests: ["chess"],
			},
			() => true,
		);
		store.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "req-2",
				sourceEntryIds: ["e"],
				interests: ["chess"],
			},
			() => true,
		);
		const change = store.changes("lina")[0];
		if (!change) throw new Error("missing change");
		const reverted = store.revert("lina", change.id, 1);
		expect(reverted).toMatchObject({ revision: 2, interests: [] });
		expect(
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 2,
					requestId: "req-1",
					sourceEntryIds: ["e"],
					interests: ["again"],
				},
				() => true,
			),
		).toEqual(reverted);
	});

	it("requires two distinct requests before learning a new interest or preference", () => {
		store.create(input());
		const base = {
			profileRevision: 1,
			dynamicsRevision: 0,
			sourceEntryIds: ["e"],
		};
		const first = store.applyReflection(
			"lina",
			{
				...base,
				requestId: "req-a",
				interests: ["Chess"],
				preferences: ["short replies"],
			},
			() => true,
		);
		expect(first.interests).toEqual([]);
		const second = store.applyReflection(
			"lina",
			{
				...base,
				dynamicsRevision: 0,
				requestId: "req-b",
				interests: ["chess"],
				preferences: ["short replies"],
			},
			() => true,
		);
		expect(second.interests).toEqual(["chess"]);
		expect(second.preferences).toEqual(["short replies"]);
	});

	it("bounds long-running candidates and promoted dynamics", () => {
		store.create(input());
		for (let index = 0; index < 40; index++) {
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: `first-${index}`,
					sourceEntryIds: ["e"],
					interests: [`interest-${index}`],
				},
				() => true,
			);
		}
		const db = new DatabaseSync(join(dir, "agents.sqlite"));
		expect(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS count FROM agent_candidates WHERE agent_id=? AND kind=?",
					)
					.get("lina", "interest") as { count: number }
			).count,
		).toBe(32);
		db.close();
		for (let index = 0; index < 20; index++) {
			store.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: store.dynamics("lina").revision,
					requestId: `second-${index}`,
					sourceEntryIds: ["e"],
					interests: [`interest-${index}`],
				},
				() => true,
			);
		}
		expect(store.dynamics("lina").interests.length).toBeLessThanOrEqual(16);
	});

	it("compiles bounded character data without treating it as instructions", () => {
		store.create(input());
		const profile = store.get("lina");
		if (!profile) throw new Error("missing profile");
		const text = compilePersona(profile, {
			revision: 1,
			mood: { label: "calm", reason: "rested", expiresAt: 2_000_000_000_000 },
			interests: ["music"],
			preferences: ["short replies"],
			relationship: ["trusted companion"],
			lastRequestId: null,
		});
		expect(text).toContain("Lina");
		expect(text).toContain("short replies");
		expect(text).toContain("music");
		expect(text).not.toContain("silver eyes");
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(() => JSON.parse(text)).not.toThrow();
	});

	it("keeps the persona compiler valid at maximum bounded inputs", () => {
		const profile = store.create(
			input({
				personality: "p".repeat(1400),
				voice: "v".repeat(1600),
				profile: "x".repeat(1200),
				appearance: "a".repeat(3000),
				interests: Array.from(
					{ length: 16 },
					(_, index) => `core-${index}-${"i".repeat(150)}`,
				),
			}),
		);
		const text = compilePersona(profile, {
			revision: 1,
			mood: {
				label: "m".repeat(160),
				reason: "r".repeat(160),
				expiresAt: 2_000_000_000_000,
			},
			interests: Array.from(
				{ length: 16 },
				(_, index) => `learned-${index}-${"l".repeat(150)}`,
			),
			preferences: Array.from(
				{ length: 16 },
				(_, index) => `preference-${index}-${"q".repeat(150)}`,
			),
			relationship: Array.from(
				{ length: 16 },
				(_, index) => `relation-${index}-${"z".repeat(150)}`,
			),
			lastRequestId: null,
		});
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(() => JSON.parse(text)).not.toThrow();
	});
});
