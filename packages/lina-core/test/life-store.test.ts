import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/index.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import type { LifeInput, SideEffectIntent } from "../src/world/life-types.ts";
import {
	identityPolicy,
	lifeCommit,
	lifeDefinition,
	socialCommit,
} from "./life-fixture.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
const stores: WorldStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-life-store-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path);
	stores.push(store);
	store.create(worldDefinition());
	return { path, store };
}
function reopen(path: string) {
	const store = new WorldStore(path);
	stores.push(store);
	return store;
}
function workInput(): LifeInput {
	const source = {
		kind: "application" as const,
		sourceId: "work-1",
		text: "Synthetic work outcome",
	};
	return {
		version: 1,
		worldId: "test-world",
		id: "work-1",
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
}
function publicationIntent(): SideEffectIntent {
	const payload = {
		kind: "publication_candidate" as const,
		eventId: "test-world:1",
	};
	return {
		version: 1,
		worldId: "test-world",
		id: "publish-1",
		lifeRevision: 1,
		payload,
		payloadDigest: lifeDigest(payload),
	};
}
function acceptedInput(store: WorldStore) {
	store.prepareLife(lifeDefinition());
	store.admitLifeInput(workInput());
	return {
		...socialCommit(),
		consumedInputIds: ["work-1"],
		effects: [publicationIntent()],
	};
}

test("explicit LIFE preparation records the current world baseline without invented past experience", () => {
	const { store, path } = fixture();
	store.accept(worldActivity());
	const baseline = store.prepareLife(lifeDefinition());
	expect(baseline).toMatchObject({
		revision: 0,
		worldRevision: 1,
		baseWorldRevision: 1,
		experiences: [],
		claims: [],
		growthHistory: [],
	});
	expect(store.prepareLife(lifeDefinition())).toEqual(baseline);
	expect(store.lifeSnapshotAt("test-world", 0)).toEqual(baseline);
	expect(store.accept(worldActivity()).replayed).toBe(true);
	expect(() =>
		store.accept(
			worldActivity({
				idempotencyKey: "legacy-new",
				expectedRevision: 1,
				simulationTime: 2,
			}),
		),
	).toThrow("LIFE_COMMIT_REQUIRED");
	expect(() =>
		store.prepareLife({ ...lifeDefinition(), habits: [] }),
	).toThrow();
	store.close();
	expect(reopen(path).lifeSnapshot("test-world")).toEqual(baseline);
});

test("event, experience, growth, input consumption and intent survive one atomic acceptance and reopen", () => {
	const { store, path } = fixture();
	const commit = acceptedInput(store);
	const receipt = store.acceptLife(commit, identityPolicy());
	expect(receipt).toMatchObject({
		worldId: "test-world",
		eventId: "test-world:1",
		worldRevision: 1,
		lifeRevision: 1,
		replayed: false,
	});
	const snapshot = store.lifeSnapshot("test-world");
	expect(snapshot.experiences).toHaveLength(2);
	expect(snapshot.traits.find((item) => item.agentId === "lina")?.value).toBe(
		1,
	);
	expect(
		snapshot.attitudes.find(
			(item) => item.fromAgentId === "lina" && item.toAgentId === "mira",
		)?.value,
	).toBe(-1);
	expect(
		snapshot.attitudes.find(
			(item) => item.fromAgentId === "mira" && item.toAgentId === "lina",
		)?.value,
	).toBe(0);
	expect(store.lifeInputs("test-world")[0]?.consumedLifeRevision).toBe(1);
	expect(store.lifeEffects("test-world")).toEqual([publicationIntent()]);
	store.close();
	const restored = reopen(path);
	expect(restored.lifeSnapshot("test-world")).toEqual(snapshot);
	expect(restored.acceptLife(commit, identityPolicy())).toEqual({
		...receipt,
		replayed: true,
	});
	expect(restored.lifeEffects("test-world")).toHaveLength(1);
	expect(() => restored.accept(commit.world)).toThrow("LIFE_COMMIT_REQUIRED");
});

test("old receipt retries compare the whole normalized input after later progress", () => {
	const { store } = fixture();
	const commit = acceptedInput(store);
	const receipt = store.acceptLife(commit, identityPolicy());
	store.acceptLife(
		lifeCommit({
			expectedLifeRevision: 1,
			world: worldActivity({
				idempotencyKey: "quiet",
				expectedRevision: 1,
				simulationTime: 2,
				kind: "tick",
				sceneId: null,
				actorIds: [],
				audience: [],
				summary: "",
				facts: [],
				moves: [],
			}),
		}),
		identityPolicy(),
	);
	expect(store.acceptLife(commit, identityPolicy())).toEqual({
		...receipt,
		replayed: true,
	});
	expect(() =>
		store.acceptLife({ ...commit, effects: [] }, identityPolicy()),
	).toThrow(/conflict/i);
	expect(() =>
		store.acceptLife({ ...commit, consumedInputIds: [] }, identityPolicy()),
	).toThrow(/conflict/i);
	const changedIdentity = identityPolicy();
	for (const profile of changedIdentity.profiles) profile.profileRevision += 1;
	expect(() => store.acceptLife(commit, changedIdentity)).toThrow(/conflict/i);
	expect(store.lifeSnapshot("test-world").revision).toBe(2);
	expect(store.lifeSnapshotAt("test-world", 1).revision).toBe(1);
});

test.each([
	["world_events", "INSERT"],
	["worlds", "UPDATE"],
	["life_commits", "INSERT"],
	["life_states", "UPDATE"],
	["life_inputs", "UPDATE"],
	["life_effects", "INSERT"],
])(
	"failure at %s %s rolls back all related state and permits one retry",
	(table, operation) => {
		const { store, path } = fixture();
		const commit = acceptedInput(store);
		const before = store.lifeSnapshot("test-world");
		const raw = new DatabaseSync(path);
		try {
			raw.exec(
				`CREATE TRIGGER reject_life BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic LIFE write failure'); END`,
			);
			expect(() => store.acceptLife(commit, identityPolicy())).toThrow(
				"synthetic LIFE write failure",
			);
			expect(store.snapshot("test-world").revision).toBe(0);
			expect(store.lifeSnapshot("test-world")).toEqual(before);
			expect(
				store.lifeInputs("test-world")[0]?.consumedLifeRevision,
			).toBeNull();
			expect(store.lifeEffects("test-world")).toEqual([]);
			raw.exec("DROP TRIGGER reject_life");
		} finally {
			raw.close();
		}
		store.close();
		const restored = reopen(path);
		expect(restored.lifeSnapshot("test-world")).toEqual(before);
		expect(restored.acceptLife(commit, identityPolicy()).replayed).toBe(false);
		expect(restored.acceptLife(commit, identityPolicy()).replayed).toBe(true);
	},
);

test.each([
	"UPDATE life_states SET life_revision = 2",
	"UPDATE life_states SET state_json = json_set(state_json, '$.checkpoint.dataDigest', 'bad')",
	"UPDATE life_config SET digest = 'bad'",
	"UPDATE life_commits SET input_digest = 'bad'",
	"DELETE FROM life_effects",
	"UPDATE life_inputs SET consumed_life_revision = NULL",
	"UPDATE life_effects SET payload_digest = 'bad'",
	"UPDATE world_definition_versions SET definition_json = json_set(definition_json, '$.title', 'tampered')",
])("startup rejects corrupt LIFE data: %s", (sql) => {
	const { store, path } = fixture();
	store.acceptLife(acceptedInput(store), identityPolicy());
	store.close();
	const raw = new DatabaseSync(path);
	try {
		raw.exec(sql);
	} finally {
		raw.close();
	}
	expect(() => reopen(path)).toThrow();
	const unchanged = new DatabaseSync(path);
	try {
		expect(
			unchanged.prepare("SELECT count(*) AS n FROM world_events").get(),
		).toEqual({ n: 1 });
	} finally {
		unchanged.close();
	}
});

test("bindings select one world with optimistic revision and survive unbind/reopen", () => {
	const { store, path } = fixture();
	store.prepareLife(lifeDefinition());
	store.create(worldDefinition("other-world"));
	store.prepareLife(lifeDefinition("other-world"));
	expect(store.worldBinding("lina")).toBeNull();
	expect(
		store.setWorldBinding("lina", 0, {
			worldId: "test-world",
			projectionPolicyRevision: 1,
		}),
	).toMatchObject({ revision: 1, worldId: "test-world" });
	expect(() =>
		store.setWorldBinding("lina", 0, {
			worldId: "other-world",
			projectionPolicyRevision: 1,
		}),
	).toThrow(/conflict/i);
	expect(
		store.setWorldBinding("lina", 1, {
			worldId: "other-world",
			projectionPolicyRevision: 1,
		}).revision,
	).toBe(2);
	expect(
		store.setWorldBinding("lina", 2, {
			worldId: null,
			projectionPolicyRevision: 0,
		}).revision,
	).toBe(3);
	store.close();
	expect(reopen(path).worldBinding("lina")).toMatchObject({
		revision: 3,
		worldId: null,
	});
});

test("preview and failed input admission leave the durable state and ownership intact", () => {
	const { store } = fixture();
	const commit = acceptedInput(store);
	const before = store.lifeSnapshot("test-world");
	const preview = store.previewLife(commit, identityPolicy());
	preview.life.experiences.length = 0;
	preview.world.scenes.length = 0;
	expect(store.lifeSnapshot("test-world")).toEqual(before);
	expect(store.admitLifeInput(workInput()).replayed).toBe(true);
	const changed = workInput();
	changed.source.text = "changed work";
	changed.payloadDigest = lifeDigest(changed.source);
	expect(() => store.admitLifeInput(changed)).toThrow(/conflict/i);
	expect(() =>
		store.acceptLife(
			{ ...commit, consumedInputIds: ["missing"] },
			identityPolicy(),
		),
	).toThrow();
	expect(store.lifeInputs("test-world")[0]?.consumedLifeRevision).toBeNull();
	expect(store.lifeSnapshot("test-world")).toEqual(before);
});

test("experience channels cannot invent direct participation or observation of a private event", () => {
	const { store } = fixture();
	store.prepareLife(lifeDefinition());
	for (const channel of ["direct", "observed"] as const) {
		const commit = lifeCommit({
			experiences: [
				{
					id: "invented-witness",
					agentId: "sol",
					eventId: "test-world:1",
					channel,
					claims: [],
					simulationTime: 1,
				},
			],
		});
		expect(() => store.acceptLife(commit, identityPolicy())).toThrow(
			/experience|participation|observation/i,
		);
	}
	expect(store.snapshot("test-world").revision).toBe(0);
});

test.each(["direct", "observed"] as const)(
	"historical %s experience must match the actual earlier event audience",
	(channel) => {
		const { store } = fixture();
		store.prepareLife(lifeDefinition());
		store.acceptLife(lifeCommit(), identityPolicy());
		const commit = lifeCommit({
			expectedLifeRevision: 1,
			world: worldActivity({
				idempotencyKey: "later",
				expectedRevision: 1,
				simulationTime: 2,
				facts: [],
			}),
			experiences: [
				{
					id: "invented-history",
					agentId: "sol",
					eventId: "test-world:1",
					channel,
					claims: [],
					simulationTime: 1,
				},
			],
		});
		expect(() => store.acceptLife(commit, identityPolicy())).toThrow(
			/experience|observation/i,
		);
		expect(store.lifeSnapshot("test-world").revision).toBe(1);
	},
);

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw Error("Child closed before its expected signal");
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text.split("\n")[0] ?? "";
	} finally {
		reader.releaseLock();
	}
}

test("LIFE acceptance survives a writer killed before graceful close", async () => {
	const { store, path } = fixture();
	const commit = acceptedInput(store);
	store.close();
	const modulePath = new URL("../src/world/index.ts", import.meta.url).pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import { WorldStore } from ${JSON.stringify(modulePath)};
const store = new WorldStore(${JSON.stringify(path)});
console.log(JSON.stringify(store.acceptLife(${JSON.stringify(commit)}, ${JSON.stringify(identityPolicy())})));
await Bun.stdin.text();
`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const accepted = JSON.parse(await readLine(child.stdout));
		expect(accepted).toMatchObject({
			lifeRevision: 1,
			worldRevision: 1,
			replayed: false,
		});
		child.kill("SIGKILL");
		await child.exited;
		const recovered = reopen(path);
		expect(recovered.lifeSnapshot("test-world").growthHistory).toHaveLength(2);
		expect(recovered.lifeEffects("test-world")).toEqual([publicationIntent()]);
		expect(recovered.lifeInputs("test-world")[0]?.consumedLifeRevision).toBe(1);
		expect(recovered.acceptLife(commit, identityPolicy())).toEqual({
			...accepted,
			replayed: true,
		});
	} finally {
		child.kill();
		await child.exited;
	}
});

test("two writer processes accept one LIFE event and preserve the winning receipt", async () => {
	const { store, path } = fixture();
	const base = acceptedInput(store);
	store.close();
	const modulePath = new URL("../src/world/index.ts", import.meta.url).pathname;
	const commits = ["first", "second"].map((key) => ({
		...base,
		world: { ...base.world, idempotencyKey: key },
	}));
	const children = commits.map((commit) =>
		Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
import { WorldStore } from ${JSON.stringify(modulePath)};
const store = new WorldStore(${JSON.stringify(path)});
console.log("ready");
await Bun.stdin.text();
try { console.log(JSON.stringify({ accepted: true, receipt: store.acceptLife(${JSON.stringify(commit)}, ${JSON.stringify(identityPolicy())}) })); }
catch (error) { console.log(JSON.stringify({ accepted: false, error: error.message })); }
finally { store.close(); }
`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		),
	);
	try {
		const ready = await Promise.all(
			children.map((child) => readLine(child.stdout)),
		);
		expect(ready).toEqual(["ready", "ready"]);
		for (const child of children) {
			child.stdin.write("go");
			child.stdin.end();
		}
		const results = await Promise.all(
			children.map(async (child) => {
				const result = JSON.parse(await readLine(child.stdout)) as {
					accepted: boolean;
					error?: string;
				};
				expect(await child.exited).toBe(0);
				return result;
			}),
		);
		expect(results.filter((result) => result.accepted)).toHaveLength(1);
		expect(results.find((result) => !result.accepted)?.error).toMatch(
			/revision conflict/i,
		);
		const recovered = reopen(path);
		expect(recovered.lifeSnapshot("test-world").revision).toBe(1);
		expect(recovered.lifeEffects("test-world")).toHaveLength(1);
		const winner = commits[results.findIndex((result) => result.accepted)];
		if (!winner) throw Error("Missing winning proposal");
		expect(recovered.acceptLife(winner, identityPolicy()).replayed).toBe(true);
	} finally {
		for (const child of children) child.kill();
		await Promise.all(children.map((child) => child.exited));
	}
});
