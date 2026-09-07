import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../src/world/index.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
const stores: WorldStore[] = [];
const limits = { maxChars: 6000, maxFacts: 20, maxEvents: 20 };
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-world-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path, () => 1000);
	stores.push(store);
	store.create(worldDefinition());
	return { store, path };
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("replay after restart returns the accepted outcome once; changed key payload conflicts", () => {
	const { store, path } = fixture();
	const first = store.accept(worldActivity());
	store.close();
	const recovered = new WorldStore(path, () => 9999);
	stores.push(recovered);
	expect(recovered.accept(worldActivity())).toEqual({
		event: first.event,
		replayed: true,
	});
	expect(recovered.snapshot("test-world").revision).toBe(1);
	expect(first.event.acceptedAt).toBe("1970-01-01T00:00:01.000Z");
	expect(() =>
		recovered.accept(worldActivity({ summary: "rerolled" })),
	).toThrow("idempotency");
	expect(recovered.context("test-world", "lina", limits).events).toHaveLength(
		1,
	);
});

test("signed-zero world creation retries normalize before persistence and comparison", () => {
	const { store } = fixture();
	const definition = { ...worldDefinition("signed-zero"), initialTime: -0 };
	store.create(definition);
	expect(store.create(definition).revision).toBe(0);
	expect(store.create(definition).simulationTime).toBe(0);
});

test("signed-zero event retries normalize before idempotent comparison", () => {
	const { store } = fixture();
	const proposal = worldActivity({ expectedRevision: -0, simulationTime: -0 });
	const accepted = store.accept(proposal);
	expect(store.accept(proposal)).toEqual({
		event: accepted.event,
		replayed: true,
	});
	expect(
		store.accept({ ...proposal, expectedRevision: 0, simulationTime: 0 })
			.replayed,
	).toBe(true);
});

test("two connections reject stale proposals without losing the winning state", () => {
	const { store, path } = fixture();
	const other = new WorldStore(path);
	stores.push(other);
	store.accept(worldActivity());
	expect(() =>
		other.accept(worldActivity({ idempotencyKey: "competitor" })),
	).toThrow("revision");
	expect(other.snapshot("test-world").revision).toBe(1);
	expect(other.snapshot("test-world").facts.map((f) => f.id)).toEqual([
		"secret",
		"bell",
		"whisper",
	]);
});

test("scoped views share one event and never reveal other agents' facts or private scenes", () => {
	const { store } = fixture();
	const { event } = store.accept(worldActivity());
	const lina = store.context("test-world", "lina", limits);
	const mira = store.context("test-world", "mira", limits);
	const sol = store.context("test-world", "sol", limits);
	expect(lina.events[0]?.id).toBe(event.id);
	expect(mira.events[0]?.id).toBe(event.id);
	expect(lina.facts.map((f) => f.id)).toEqual(["secret", "bell"]);
	expect(mira.facts.map((f) => f.id)).toEqual(["bell", "whisper"]);
	expect(JSON.stringify(lina)).not.toContain("private word");
	expect(JSON.stringify(mira)).not.toContain("hidden key");
	expect(sol.events).toEqual([]);
	expect(sol.facts).toEqual([]);
	expect(sol.scene?.id).toBe("reading");
	expect(JSON.stringify(sol)).not.toContain("quiet meeting");
	expect(() => store.context("test-world", "stranger", limits)).toThrow(
		"agent",
	);
});

test("preview and rejected transitions leave time, occupancy, facts and receipts untouched", () => {
	const { store } = fixture();
	const before = store.snapshot("test-world");
	const proposal = worldActivity({
		moves: [{ agentId: "mira", sceneId: "reading" }],
	});
	expect(store.preview(proposal).scenes[1]?.occupants).toEqual(["sol", "mira"]);
	expect(store.snapshot("test-world")).toEqual(before);
	expect(() =>
		store.accept(
			worldActivity({ facts: [{ id: "bad", text: "leak", knownTo: ["sol"] }] }),
		),
	).toThrow("audience");
	expect(() =>
		store.accept(
			worldActivity({ moves: [{ agentId: "sol", sceneId: "meeting" }] }),
		),
	).toThrow("actor");
	expect(store.snapshot("test-world")).toEqual(before);
	expect(store.accept(proposal).replayed).toBe(false);
	expect(store.snapshot("test-world").scenes[1]?.occupants).toEqual([
		"sol",
		"mira",
	]);
	expect(store.context("test-world", "sol", limits).events).toEqual([]);
});

test("quiet ticks are deliberate, monotonic and idempotent without generating activity", () => {
	const { store, path } = fixture();
	const tick = worldActivity({
		kind: "tick",
		sceneId: null,
		actorIds: [],
		audience: [],
		summary: "",
		facts: [],
		simulationTime: 8,
	});
	store.accept(tick);
	store.close();
	const recovered = new WorldStore(path);
	stores.push(recovered);
	expect(recovered.snapshot("test-world").simulationTime).toBe(8);
	expect(recovered.context("test-world", "lina", limits).events).toEqual([]);
	expect(recovered.accept(tick).replayed).toBe(true);
	expect(() =>
		recovered.accept({
			...tick,
			idempotencyKey: "backwards",
			expectedRevision: 1,
			simulationTime: 7,
		}),
	).toThrow("time");
});

test("world definitions are immutable; invalid references and executable fields are rejected", () => {
	const { store } = fixture();
	expect(store.create(worldDefinition()).revision).toBe(0);
	expect(() => store.create({ ...worldDefinition(), version: 2 })).toThrow(
		"definition",
	);
	expect(() =>
		store.create({ ...worldDefinition("other"), scripts: ["run()"] } as never),
	).toThrow("fields");
	expect(() =>
		store.create({ ...worldDefinition("other"), agents: ["lina", "lina"] }),
	).toThrow("duplicate");
	expect(() =>
		store.create({
			...worldDefinition("other"),
			lore: [{ id: "x", text: "x", knownTo: ["unknown"] }],
		}),
	).toThrow("agent");
});

test("context budgets are explicit and whole-record bounded with omissions reported", () => {
	const { store } = fixture();
	store.accept(worldActivity());
	const view = store.context("test-world", "mira", {
		maxChars: 500,
		maxFacts: 1,
		maxEvents: 0,
	});
	expect(JSON.stringify(view).length).toBeLessThanOrEqual(500);
	expect(view.truncated).toBe(true);
	expect(view.events).toEqual([]);
	expect(() =>
		store.context("test-world", "lina", { ...limits, maxChars: 1 }),
	).toThrow("budget");
	expect(() =>
		store.context("test-world", "lina", { ...limits, maxFacts: -1 }),
	).toThrow();
});

test("agents can leave and explicitly re-enter a scene without learning earlier private events", () => {
	const { store } = fixture();
	store.accept(worldActivity({ moves: [{ agentId: "mira", sceneId: null }] }));
	expect(store.context("test-world", "mira", limits).scene).toBeNull();
	store.accept(
		worldActivity({
			idempotencyKey: "return",
			expectedRevision: 1,
			simulationTime: 2,
			actorIds: ["mira"],
			audience: ["mira"],
			summary: "Mira returned",
			facts: [],
			moves: [{ agentId: "mira", sceneId: "meeting" }],
		}),
	);
	expect(store.context("test-world", "mira", limits).scene?.occupants).toEqual([
		"lina",
		"mira",
	]);
	expect(store.context("test-world", "lina", limits).events).toHaveLength(1);
});

test("definitions whose expanded checkpoint exceeds storage capacity are rejected before creation", () => {
	const { store } = fixture();
	const definition = worldDefinition("oversized");
	definition.scenes = Array.from({ length: 20 }, (_, i) => ({
		id: `scene-${i}`,
		placeId: "garden",
		description: "a".repeat(32_768),
		occupants: [],
	}));
	expect(() => {
		store.create(definition);
	}).toThrow("capacity");
	expect(() => store.snapshot("oversized")).toThrow("Unknown world");
});

test("historical scene snapshots remain tied to the accepted event revision after later moves and restart", () => {
	const { store, path } = fixture();
	const first = store.accept(worldActivity()).event;
	store.accept(
		worldActivity({
			idempotencyKey: "later-move",
			expectedRevision: 1,
			simulationTime: 2,
			facts: [],
			moves: [{ agentId: "mira", sceneId: "reading" }],
		}),
	);
	store.close();
	const restored = new WorldStore(path);
	stores.push(restored);
	expect(
		restored.snapshotAt("test-world", first.revision).scenes[0]?.occupants,
	).toEqual(["lina", "mira"]);
	expect(restored.snapshot("test-world").scenes[0]?.occupants).toEqual([
		"lina",
	]);
	expect(restored.snapshotAt("test-world", 0).facts.map((f) => f.id)).toEqual([
		"secret",
	]);
	expect(() => restored.snapshotAt("test-world", 3)).toThrow("revision");
});
