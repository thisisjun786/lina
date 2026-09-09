import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	WorldAuthoringPort,
	WorldPack,
	WorldPreviewOptions,
} from "../src/world/authoring-types.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	identityPolicy,
	lifeCommit,
	lifeDefinition,
	required,
	socialCommit,
} from "./life-fixture.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

const roots: string[] = [],
	stores: WorldStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function open(path: string) {
	const store = new WorldStore(path);
	stores.push(store);
	return store as WorldStore & WorldAuthoringPort;
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-store-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	return { path, store: open(path) };
}

test.each([null, "dispatch_unknown"])(
	"reopen rejects impossible failed dispatch state with error %s",
	(error) => {
		const { path, store } = setup(),
			draft = draftPack(store);
		store.prepareWorldSuggestion({
			requestId: "broken-failure",
			draftId: draft.id,
			draftRevision: draft.revision,
			agentId: "lina",
			modelSettingsRevision: 1,
		});
		store.dispatchWorldSuggestion("broken-failure");
		store.close();
		const raw = new DatabaseSync(path),
			row = raw
				.prepare("SELECT request_json FROM world_authoring_requests")
				.get() as { request_json: string };
		const request = JSON.parse(row.request_json) as Record<string, unknown>;
		request["status"] = "failed";
		request["error"] = error;
		raw
			.prepare("UPDATE world_authoring_requests SET request_json = ?")
			.run(JSON.stringify(request));
		raw.close();
		expect(() => {
			open(path);
		}).toThrow();
	},
);

test.each(["changes", "evaluation", "version", "scope", "draw"])(
	"reopen rejects malformed stored preview %s even with consistent checksums",
	(field) => {
		const { path, store } = setup(),
			draft = draftPack(store);
		store.activateWorldDraft(confirm(store, draft));
		store.close();
		const raw = new DatabaseSync(path),
			row = raw
				.prepare(
					"SELECT confirmation_json, receipt_json FROM world_activations",
				)
				.get() as { confirmation_json: string; receipt_json: string };
		const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>,
			confirmation = JSON.parse(row.confirmation_json) as Record<
				string,
				unknown
			>;
		const preview = receipt["preview"] as Record<string, unknown>;
		if (field === "scope" || field === "draw") {
			const evaluation = preview["evaluation"] as Record<string, unknown>;
			if (field === "scope") evaluation["agentId"] = "mira";
			else evaluation["draws"] = [{ id: "lore:x", value: 1 }];
			const { digest: _evaluationDigest, ...evaluationBody } = evaluation;
			evaluation["digest"] = lifeDigest(evaluationBody);
		} else
			preview[field] =
				field === "changes"
					? "not-an-object"
					: field === "evaluation"
						? { version: 77, executable: "unsupported" }
						: 2;
		const { digest: _digest, ...body } = preview;
		preview["digest"] = lifeDigest(body);
		confirmation["previewDigest"] = preview["digest"];
		receipt["inputDigest"] = lifeDigest(confirmation);
		raw
			.prepare(
				"UPDATE world_activations SET confirmation_json = ?, receipt_json = ?, input_digest = ?",
			)
			.run(
				JSON.stringify(confirmation),
				JSON.stringify(receipt),
				receipt["inputDigest"] as string,
			);
		raw.close();
		expect(() => {
			open(path);
		}).toThrow();
	},
);
function pack(): WorldPack {
	return {
		schemaVersion: 1,
		worldId: "test-world",
		version: 1,
		background: {
			authoredText: "Synthetic user setting",
			era: null,
			environment: "garden",
			description: null,
		},
		world: worldDefinition(),
		life: lifeDefinition(),
		constraints: [],
		roles: ["lina", "mira", "sol"].map((agentId) => ({
			agentId,
			roleId: "resident",
			description: "Authored role",
			status: "active",
		})),
		variables: [],
		predicates: [],
		lore: [],
		rules: [],
		eventFamilies: [],
		unresolved: [],
		importReport: [],
	};
}
function options(
	expectedWorldRevision: number | null = null,
): WorldPreviewOptions {
	return {
		expectedWorldRevision,
		simulationTime: expectedWorldRevision ?? 0,
		agentId: "lina",
		targetAgentId: null,
		seed: "synthetic",
		limits: {
			maxChars: 2000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 1000,
		},
		relocations: [],
	};
}
function draftPack(store: WorldAuthoringPort, value = pack()) {
	const draft = store.draftWorld({
		worldId: value.worldId,
		authoredText: value.background.authoredText,
	});
	return store.editWorldDraft(draft.id, draft.revision, {
		authoredText: draft.authoredText,
		pack: value,
	});
}
function confirm(
	store: WorldAuthoringPort,
	draft: ReturnType<typeof draftPack>,
	selected = options(),
	key = "activate-1",
) {
	const preview = store.previewWorldDraft(draft.id, draft.revision, selected);
	if (!preview.packDigest) throw Error("Fixture pack missing");
	return {
		draftId: draft.id,
		expectedRevision: draft.revision,
		idempotencyKey: key,
		packDigest: preview.packDigest,
		previewDigest: preview.digest,
		options: selected,
	};
}

test("partial authored text persists without invented settings or operational defaults", () => {
	const { path, store } = setup();
	const draft = store.draftWorld({
		worldId: "test-world",
		authoredText: "Only an era and garden",
	});
	expect(draft.pack).toBeNull();
	expect(draft.unresolved.some((question) => question.blocking)).toBe(true);
	expect(store.worldCatalog({ afterId: null, limit: 10 }).items).toEqual([]);
	store.close();
	expect(open(path).worldDraft(draft.id)).toEqual(draft);
});

test("confirmation atomically creates a world and LIFE baseline; exact replay survives later draft edits and restart", () => {
	const { path, store } = setup();
	const draft = draftPack(store),
		input = confirm(store, draft);
	const receipt = store.activateWorldDraft(input);
	expect(receipt).toMatchObject({
		worldVersion: 1,
		worldRevision: 0,
		lifeRevision: 0,
		eventId: null,
		replayed: false,
	});
	expect(store.lifeConfig("test-world")).toMatchObject({
		revision: 0,
		clock: null,
		run: null,
		models: null,
		publication: null,
		usage: null,
		images: null,
		avatars: null,
	});
	store.editWorldDraft(draft.id, draft.revision, {
		authoredText: "Later input",
		pack: null,
	});
	store.close();
	const reopened = open(path);
	expect(reopened.activateWorldDraft(input)).toEqual({
		...receipt,
		replayed: true,
	});
	expect(() =>
		reopened.activateWorldDraft({
			...input,
			options: { ...input.options, seed: "different" },
		}),
	).toThrow(/conflict/i);
	expect(reopened.worldPack("test-world", 1)).toEqual(pack());
});

test("world version and LIFE config revision advance independently with old events byte-stable", () => {
	const { path, store } = setup();
	const first = pack();
	first.version = 7;
	first.world.version = 7;
	const initialDraft = draftPack(store, first);
	store.activateWorldDraft(confirm(store, initialDraft));
	store.acceptLife(socialCommit(), identityPolicy());
	store.setWorldBinding("lina", 0, {
		worldId: "test-world",
		projectionPolicyRevision: 1,
	});
	const before = store.lifeSnapshot("test-world");
	const raw = new DatabaseSync(path);
	const bytes = raw.prepare("SELECT event_json FROM world_events").all();
	raw.close();
	const second = structuredClone(first);
	second.version = 8;
	second.world.version = 8;
	second.world.title = "Updated setting";
	second.life.revision = 2;
	const draft = draftPack(store, second),
		input = confirm(store, draft, options(1), "activate-8");
	const receipt = store.activateWorldDraft(input);
	expect(receipt).toMatchObject({
		worldVersion: 8,
		worldRevision: 2,
		lifeRevision: 2,
		eventId: "test-world:2",
	});
	expect(store.lifeSnapshot("test-world").experiences).toEqual(
		before.experiences,
	);
	expect(store.worldBinding("lina")?.revision).toBe(2);
	expect(() =>
		store.acceptLife(
			lifeCommit({
				expectedLifeRevision: 1,
				world: worldActivity({
					idempotencyKey: "stale",
					expectedRevision: 1,
					simulationTime: 2,
					facts: [],
				}),
			}),
			identityPolicy(),
		),
	).toThrow();
	store.close();
	const reopened = open(path);
	expect(reopened.snapshotAt("test-world", 1).definition.version).toBe(7);
	expect(reopened.lifeSnapshotAt("test-world", 1)).toEqual(before);
	expect(reopened.snapshot("test-world").definition.version).toBe(8);
	expect(reopened.lifeDefinition("test-world").revision).toBe(2);
	const after = new DatabaseSync(path);
	expect(
		after
			.prepare("SELECT event_json FROM world_events WHERE revision = 1")
			.all(),
	).toEqual(bytes);
	after.close();
});

test("grant-bound reads/writes reject foreign drafts and revoked authority even after reopen", () => {
	const { path, store } = setup();
	const draft = draftPack(store);
	const other = store.draftWorld({
		worldId: "other",
		authoredText: "Other background",
	});
	const grant = store.grantWorldAuthor("test-world", "lina"),
		scope = { grantId: grant.id, grantRevision: grant.revision };
	expect(store.worldDraft(draft.id, scope)).toEqual(draft);
	expect(() => store.worldDraft(other.id, scope)).toThrow();
	expect(
		store
			.worldDrafts({ afterId: null, limit: 10 }, scope)
			.items.map((item) => item.id),
	).toEqual([draft.id]);
	store.revokeWorldAuthor(grant.id, grant.revision);
	store.close();
	expect(() => open(path).worldDraft(draft.id, scope)).toThrow(
		/revoked|grant/i,
	);
});

test("durable suggestion dispatch deduplicates concurrent stores and becomes uncertain after recovery", () => {
	const { path, store } = setup();
	const draft = draftPack(store),
		peer = open(path);
	const request = {
		requestId: "suggest-1",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	expect(store.prepareWorldSuggestion(request).status).toBe("prepared");
	expect(store.dispatchWorldSuggestion(request.requestId).dispatched).toBe(
		true,
	);
	expect(peer.dispatchWorldSuggestion(request.requestId).dispatched).toBe(
		false,
	);
	expect(() =>
		peer.prepareWorldSuggestion({ ...request, requestId: "bypass" }),
	).toThrow();
	store.close();
	peer.close();
	const reopened = open(path);
	expect(reopened.worldSuggestion(request.requestId).status).toBe("unknown");
	expect(reopened.dispatchWorldSuggestion(request.requestId).dispatched).toBe(
		false,
	);
	reopened.abandonWorldSuggestion(request.requestId);
	expect(
		reopened.prepareWorldSuggestion({ ...request, requestId: "resolved-new" })
			.status,
	).toBe("prepared");
});

test("suggestion result and new revision commit together without changing raw authored text", () => {
	const { path, store } = setup();
	const draft = store.draftWorld({
		worldId: "test-world",
		authoredText: "User original background",
	});
	const input = {
		requestId: "suggest-1",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	store.prepareWorldSuggestion(input);
	store.dispatchWorldSuggestion(input.requestId);
	const completed = store.finishWorldSuggestion(input.requestId, {
		pack: pack(),
		provider: "synthetic",
		model: "fixture",
	});
	expect(completed.status).toBe("succeeded");
	expect(completed.result?.draft.authoredText).toBe(draft.authoredText);
	store.close();
	expect(open(path).prepareWorldSuggestion(input)).toEqual(completed);
});

test.each([
	"UPDATE world_packs SET effective_revision = 1",
	"UPDATE world_activations SET receipt_json = json_set(receipt_json, '$.worldRevision', 1, '$.lifeRevision', 1)",
	"DELETE FROM world_activations",
	"UPDATE world_draft_versions SET digest = 'bad'",
	"UPDATE world_packs SET digest = 'bad'",
	"UPDATE world_drafts SET revision = 20",
])("recovery rejects damaged authoring provenance: %s", (sql) => {
	const { path, store } = setup();
	const draft = draftPack(store);
	store.activateWorldDraft(confirm(store, draft));
	store.acceptLife(socialCommit(), identityPolicy());
	store.close();
	const raw = new DatabaseSync(path);
	raw.exec(sql);
	raw.close();
	expect(() => {
		open(path);
	}).toThrow();
});

test.each(["worlds", "life_states", "world_packs", "world_activations"])(
	"failure at initial confirmation %s insertion leaves no partial world",
	(table) => {
		const { path, store } = setup();
		const draft = draftPack(store),
			input = confirm(store, draft);
		const raw = new DatabaseSync(path);
		raw.exec(
			`CREATE TRIGGER reject_author BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic author failure'); END`,
		);
		expect(() => store.activateWorldDraft(input)).toThrow(
			"synthetic author failure",
		);
		expect(raw.prepare("SELECT count(*) AS n FROM worlds").get()).toEqual({
			n: 0,
		});
		expect(raw.prepare("SELECT count(*) AS n FROM world_packs").get()).toEqual({
			n: 0,
		});
		raw.exec("DROP TRIGGER reject_author");
		raw.close();
		expect(store.activateWorldDraft(input).replayed).toBe(false);
		store.close();
		expect(open(path).worldPack("test-world")).toEqual(pack());
	},
);

test("suggestion result SQL failure leaves original input and dispatch uncertainty recoverable", () => {
	const { path, store } = setup(),
		draft = draftPack(store);
	const input = {
		requestId: "suggest-fault",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	store.prepareWorldSuggestion(input);
	store.dispatchWorldSuggestion(input.requestId);
	const raw = new DatabaseSync(path);
	raw.exec(
		"CREATE TRIGGER reject_result BEFORE UPDATE ON world_authoring_requests BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END",
	);
	expect(() =>
		store.finishWorldSuggestion(input.requestId, {
			pack: pack(),
			provider: "synthetic",
			model: "fixture",
		}),
	).toThrow("synthetic result failure");
	expect(store.worldDraft(draft.id)).toEqual(draft);
	raw.exec("DROP TRIGGER reject_result");
	raw.close();
	store.close();
	const recovered = open(path);
	expect(recovered.worldSuggestion(input.requestId).status).toBe("unknown");
	expect(recovered.worldDraft(draft.id)).toEqual(draft);
});

test("retirement keeps historical relationships and exact retry while rejecting new action", () => {
	const { path, store } = setup(),
		draft = draftPack(store);
	store.activateWorldDraft(confirm(store, draft));
	const committed = socialCommit(),
		receipt = store.acceptLife(committed, identityPolicy());
	const updated = pack();
	updated.version = 2;
	updated.world.version = 2;
	updated.life.revision = 2;
	required(updated.roles.find((role) => role.agentId === "mira")).status =
		"retired";
	for (const scene of updated.world.scenes)
		scene.occupants = scene.occupants.filter((agent) => agent !== "mira");
	const second = draftPack(store, updated),
		boundary = options(1);
	boundary.relocations = [{ agentId: "mira", sceneId: null }];
	store.activateWorldDraft(confirm(store, second, boundary, "retire-mira"));
	expect(store.acceptLife(committed, identityPolicy())).toEqual({
		...receipt,
		replayed: true,
	});
	expect(
		store
			.lifeSnapshot("test-world")
			.attitudes.find(
				(row) => row.fromAgentId === "lina" && row.toAgentId === "mira",
			)?.value,
	).toBe(-1);
	expect(() =>
		store.acceptLife(
			lifeCommit({
				expectedLifeRevision: 2,
				definitionRevision: 2,
				world: worldActivity({
					idempotencyKey: "retired-action",
					expectedRevision: 2,
					simulationTime: 2,
					facts: [],
				}),
			}),
			identityPolicy(),
		),
	).toThrow(/retired/i);
	store.close();
	expect(
		open(path)
			.snapshot("test-world")
			.scenes.flatMap((scene) => scene.occupants),
	).not.toContain("mira");
});

test("a maximum-length confirmation key supports version changes and restart replay", () => {
	const { path, store } = setup(),
		draft = draftPack(store);
	store.activateWorldDraft(confirm(store, draft));
	const second = pack();
	second.version = 2;
	second.world.version = 2;
	second.life.revision = 2;
	const updated = draftPack(store, second),
		input = confirm(store, updated, options(0), "x".repeat(128));
	const receipt = store.activateWorldDraft(input);
	store.close();
	expect(open(path).activateWorldDraft(input)).toEqual({
		...receipt,
		replayed: true,
	});
});

test("a structurally incomplete pack reports missing simulation structure and cannot activate", () => {
	const { store } = setup(),
		incomplete = pack();
	incomplete.world.places = [];
	incomplete.world.scenes = [];
	const draft = draftPack(store, incomplete),
		preview = store.previewWorldDraft(draft.id, draft.revision, options());
	expect(preview.canActivate).toBe(false);
	expect(preview.unresolved.some((question) => question.blocking)).toBe(true);
	expect(() => store.activateWorldDraft(confirm(store, draft))).toThrow();
});

test("a killed suggestion dispatcher recovers as unknown without a second dispatch", async () => {
	const { path, store } = setup(),
		draft = draftPack(store);
	const request = {
		requestId: "killed-dispatch",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	store.prepareWorldSuggestion(request);
	store.close();
	const modulePath = new URL("../src/world/store.ts", import.meta.url).pathname;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import { WorldStore } from ${JSON.stringify(modulePath)};
const store = new WorldStore(${JSON.stringify(path)});
console.log(JSON.stringify(store.dispatchWorldSuggestion("killed-dispatch")));
await Bun.stdin.text();
`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	try {
		const reader = child.stdout.getReader();
		let output = "";
		try {
			while (!output.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw Error("Dispatcher exited before dispatch marker");
				output += new TextDecoder().decode(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		expect(JSON.parse(output.split("\n")[0] ?? "").dispatched).toBe(true);
		// A peer can inspect the live marker without stealing or resetting it.
		const peer = open(path);
		expect(peer.worldSuggestion(request.requestId).status).toBe("dispatched");
		peer.close();
		child.kill("SIGKILL");
		await child.exited;
		const recovered = open(path);
		expect(recovered.worldSuggestion(request.requestId).status).toBe("unknown");
		expect(
			recovered.dispatchWorldSuggestion(request.requestId).dispatched,
		).toBe(false);
		expect(() =>
			recovered.prepareWorldSuggestion({
				...request,
				requestId: "new-key-bypass",
			}),
		).toThrow();
	} finally {
		child.kill();
		await child.exited;
	}
});

test.each([
	["life_config", "INSERT"],
	["world_events", "INSERT"],
	["worlds", "UPDATE"],
	["life_commits", "INSERT"],
	["life_states", "UPDATE"],
	["world_bindings", "UPDATE"],
	["world_packs", "INSERT"],
	["world_activations", "INSERT"],
])(
	"version activation failure at %s %s restores all ledgers and binding revisions",
	(table, operation) => {
		const { path, store } = setup(),
			first = draftPack(store);
		store.activateWorldDraft(confirm(store, first));
		store.acceptLife(socialCommit(), identityPolicy());
		store.setWorldBinding("lina", 0, {
			worldId: "test-world",
			projectionPolicyRevision: 1,
		});
		const before = store.lifeSnapshot("test-world"),
			world = store.snapshot("test-world");
		const second = pack();
		second.version = 2;
		second.world.version = 2;
		second.life.revision = 2;
		const draft = draftPack(store, second),
			input = confirm(store, draft, options(1), "update-fault");
		const raw = new DatabaseSync(path);
		raw.exec(
			`CREATE TRIGGER reject_version BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic version failure'); END`,
		);
		expect(() => store.activateWorldDraft(input)).toThrow(
			"synthetic version failure",
		);
		expect(store.snapshot("test-world")).toEqual(world);
		expect(store.lifeSnapshot("test-world")).toEqual(before);
		expect(store.worldBinding("lina")?.revision).toBe(1);
		expect(raw.prepare("SELECT count(*) AS n FROM life_config").get()).toEqual({
			n: 1,
		});
		raw.exec("DROP TRIGGER reject_version");
		raw.close();
		store.close();
		const recovered = open(path);
		expect(recovered.lifeSnapshot("test-world")).toEqual(before);
		expect(recovered.activateWorldDraft(input).replayed).toBe(false);
		expect(recovered.activateWorldDraft(input).replayed).toBe(true);
	},
);

test("explicit nullable operational settings round trip with revision conflicts and no model/scheduler side effects", () => {
	const { path, store } = setup(),
		draft = draftPack(store);
	store.activateWorldDraft(confirm(store, draft));
	const {
		worldId: _worldId,
		revision: _revision,
		...unset
	} = store.lifeConfig("test-world");
	const input = {
		...unset,
		clock: { stepSize: 3, intervalMs: null, maxCatchUpSteps: 0 },
		run: { mode: "manual" as const },
	};
	const config = store.setLifeConfig("test-world", 0, input);
	expect(config).toMatchObject({
		revision: 1,
		models: null,
		publication: null,
		usage: null,
		clock: input.clock,
	});
	expect(() => store.setLifeConfig("test-world", 0, input)).toThrow(
		/conflict/i,
	);
	expect(store.snapshot("test-world").revision).toBe(0);
	store.close();
	expect(open(path).lifeConfig("test-world")).toEqual(config);
});

test("incomplete suggestions persist questions, raw input and exact result together across restart", () => {
	const { path, store } = setup(),
		draft = store.draftWorld({
			worldId: "test-world",
			authoredText: "Only era and environment chosen",
		});
	const input = {
		requestId: "questions",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	store.prepareWorldSuggestion(input);
	store.dispatchWorldSuggestion(input.requestId);
	const result = {
		pack: null,
		unresolved: [
			{ id: "participants", question: "Who participates?", blocking: true },
		],
		provider: "synthetic",
		model: "fixture",
	};
	const completed = store.finishWorldSuggestion(input.requestId, result);
	expect(completed.result?.draft).toMatchObject({
		pack: null,
		authoredText: draft.authoredText,
		unresolved: result.unresolved,
	});
	expect(store.worldCatalog({ afterId: null, limit: 10 }).items).toEqual([]);
	store.close();
	const restored = open(path);
	expect(restored.prepareWorldSuggestion(input)).toEqual(completed);
	expect(restored.finishWorldSuggestion(input.requestId, result)).toEqual(
		completed,
	);
	expect(() =>
		restored.finishWorldSuggestion(input.requestId, {
			...result,
			unresolved: [
				{
					...result.unresolved[0],
					id: "changed",
					question: "Different?",
					blocking: true,
				},
			],
		}),
	).toThrow(/conflict/i);
});

test.each(
	[
		[],
		[{ id: "q", question: "Optional only", blocking: false }],
		[
			{ id: "q", question: "First", blocking: true },
			{ id: "q", question: "Duplicate", blocking: true },
		],
		[{ id: "q", question: "x".repeat(4097), blocking: true }],
	].map((unresolved, index) => [index, unresolved] as const),
)(
	"invalid incomplete result case %i cannot change the authored draft",
	(_index, unresolved) => {
		const { store } = setup(),
			draft = store.draftWorld({
				worldId: "test-world",
				authoredText: "Incomplete",
			});
		store.prepareWorldSuggestion({
			requestId: "invalid-questions",
			draftId: draft.id,
			draftRevision: draft.revision,
			agentId: "lina",
			modelSettingsRevision: 1,
		});
		store.dispatchWorldSuggestion("invalid-questions");
		expect(() =>
			store.finishWorldSuggestion("invalid-questions", {
				pack: null,
				unresolved,
				provider: "synthetic",
				model: "fixture",
			}),
		).toThrow();
		expect(store.worldDraft(draft.id)).toEqual(draft);
	},
);
