import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorldPack } from "../../lina-core/src/world/authoring-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	projectLifePerception,
	projectPublication,
} from "../../lina-core/src/world/views.ts";
import {
	identityPolicy,
	lifeCommit,
	required,
	socialCommit,
} from "../../lina-core/test/life-fixture.ts";
import {
	socialIntent,
	socialPack,
} from "../../lina-core/test/life-social-pack-fixture.ts";
import {
	activateSocialPack,
	socialRequest,
} from "../../lina-core/test/life-social-store-fixture.ts";
import { worldActivity } from "../../lina-core/test/world-fixture.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { createSocialService } from "../src/life/social/service.ts";

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
	return store;
}
function setup(pack = socialPack()) {
	const root = mkdtempSync(join(tmpdir(), "lina-social-service-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = activateSocialPack(open(path), pack);
	return {
		path,
		store,
		service: createSocialService({
			store,
			engine: createEnsembleSocialEngine(),
			identity: identityPolicy,
			entropy: () => 123456,
		}),
	};
}

function updatePack(
	store: WorldStore,
	pack: WorldPack,
	key: string,
	relocations: Array<{ agentId: string; sceneId: string | null }> = [],
) {
	const world = store.snapshot(pack.worldId);
	const draft = store.draftWorld({
		worldId: pack.worldId,
		authoredText: pack.background.authoredText,
	});
	const edited = store.editWorldDraft(draft.id, draft.revision, {
		authoredText: draft.authoredText,
		pack,
	});
	const options = {
		expectedWorldRevision: world.revision,
		simulationTime: world.simulationTime,
		agentId: "lina",
		targetAgentId: null,
		seed: "synthetic",
		limits: {
			maxChars: 2000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 1000,
		},
		relocations,
	};
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	if (!preview.packDigest) throw Error("Missing candidate pack");
	return store.activateWorldDraft({
		draftId: edited.id,
		expectedRevision: edited.revision,
		idempotencyKey: key,
		previewDigest: preview.digest,
		packDigest: preview.packDigest,
		options,
	});
}

test("the real engine result is saved before acceptance and reused after reopening without dispatch", async () => {
	const { path, store, service } = setup();
	const request = socialRequest(),
		signal = new AbortController().signal;
	const prepared = await service.resolve(request, signal);
	expect(prepared.result?.outcome).toBe("accepted");
	expect(store.lifeSnapshot("test-world").revision).toBe(0);
	store.close();
	const restarted = open(path);
	const restored = createSocialService({
		store: restarted,
		identity: identityPolicy,
		engine: {
			async resolve() {
				throw Error("must reuse saved result");
			},
		},
		entropy: () => {
			throw Error("must reuse seed");
		},
	});
	expect(await restored.resolve(request, signal)).toEqual(prepared);
	const receipt = restored.accept("test-world", "request-1");
	expect(receipt).toMatchObject({
		worldRevision: 1,
		lifeRevision: 1,
		replayed: false,
	});
	expect(restored.accept("test-world", "request-1").replayed).toBe(true);
	expect(
		restarted
			.lifeSnapshot("test-world")
			.attitudes.find((x) => x.fromAgentId === "lina" && x.toAgentId === "mira")
			?.value,
	).toBe(1);
	restarted.close();
	const again = open(path);
	expect(again.lifeSnapshot("test-world").revision).toBe(1);
	expect(
		again.socialResolution("test-world", "request-1").acceptedLifeRevision,
	).toBe(1);
});

test("a real reveal learns a private fact durably without granting publication or changing the original", async () => {
	const pack = socialPack();
	pack.life.projection.disclosures = [
		{
			subject: { kind: "world_fact", id: "secret" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "mira" }],
				publication: [],
			},
		},
	];
	const { path, store, service } = setup(pack);
	const original = JSON.stringify(store.snapshot("test-world").facts);
	const request = socialRequest({
		intent: {
			...socialIntent(),
			primitives: [
				{
					kind: "reveal",
					claim: { kind: "world_fact", id: "secret" },
					toAgentId: "mira",
				},
			],
		},
	});
	const resolved = await service.resolve(request, new AbortController().signal);
	if (!resolved.result) throw Error("Missing social result");
	expect(resolved.result.effects).toContainEqual({
		kind: "reveal",
		fromAgentId: "lina",
		toAgentId: "mira",
		claim: { kind: "world_fact", id: "secret" },
	});
	service.accept("test-world", "request-1");
	store.close();
	const restarted = open(path),
		world = restarted.snapshot("test-world"),
		life = restarted.lifeSnapshot("test-world"),
		def = restarted.lifeDefinition("test-world");
	const limits = { maxChars: 10000, maxRecords: 100 };
	const view = (agentId: string) =>
		projectLifePerception(
			world,
			life,
			def,
			{ purpose: "life", worldId: "test-world", agentId },
			limits,
		);
	expect(view("mira").facts).toContainEqual({
		id: "secret",
		text: "The hidden key is blue",
	});
	expect(view("sol").facts).toEqual([]);
	expect(life.beliefs).toEqual([]);
	expect(JSON.stringify(world.facts)).toBe(original);
	expect(
		projectPublication(
			world,
			life,
			[],
			def.projection,
			{
				purpose: "publication",
				worldId: "test-world",
				agentId: "mira",
				recipientId: "feed",
			},
			limits,
		).facts,
	).toEqual([]);
});

test("a confirmed background update preserves a nonempty checkpoint and historical snapshots after reopening", async () => {
	const { path, store, service } = setup();
	await service.resolve(socialRequest(), new AbortController().signal);
	service.accept("test-world", "request-1");
	const before = store.lifeSnapshot("test-world");
	const pack = store.worldPack("test-world");
	pack.version++;
	pack.world.version++;
	pack.life.revision++;
	pack.background.authoredText =
		"The same residents, with a revised authored background";
	const draft = store.draftWorld({
		worldId: pack.worldId,
		authoredText: pack.background.authoredText,
	});
	const edited = store.editWorldDraft(draft.id, draft.revision, {
		authoredText: draft.authoredText,
		pack,
	});
	const options = {
		expectedWorldRevision: 1,
		simulationTime: 1,
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
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	expect(preview.version).toBe(2);
	if (preview.version !== 2 || !preview.packDigest)
		throw Error("Missing social migration preview");
	expect(preview.socialMigration?.previousCheckpointDigest).toBe(
		lifeDigest(before.checkpoint),
	);
	const receipt = store.activateWorldDraft({
		draftId: edited.id,
		expectedRevision: edited.revision,
		idempotencyKey: "background-update",
		previewDigest: preview.digest,
		packDigest: preview.packDigest,
		options,
	});
	expect(receipt).toMatchObject({
		version: 2,
		worldVersion: 2,
		lifeRevision: 2,
	});
	const after = store.lifeSnapshot("test-world");
	if (
		before.checkpoint.engineId !== "ensemble" ||
		after.checkpoint.engineId !== "ensemble"
	)
		throw Error("Missing engine checkpoint");
	expect(after.checkpoint.data.rng).toEqual(before.checkpoint.data.rng);
	expect(after.checkpoint.data.state.history).toEqual(
		before.checkpoint.data.state.history,
	);
	store.close();
	const restarted = open(path);
	expect(restarted.lifeSnapshot("test-world")).toEqual(after);
	expect(restarted.lifeSnapshotAt("test-world", 1)).toEqual(before);
	const continued = createSocialService({
		store: restarted,
		engine: createEnsembleSocialEngine(),
		identity: identityPolicy,
	});
	const request = socialRequest({
		requestId: "after-migration",
		simulationTime: 2,
	});
	expect(
		(await continued.resolve(request, new AbortController().signal)).result
			?.outcome,
	).toBe("accepted");
	expect(continued.accept("test-world", request.requestId).lifeRevision).toBe(
		3,
	);
});

test("revocation invalidates a prepared disclosure while old valid knowledge survives reopening", async () => {
	const pack = socialPack();
	pack.life.projection.disclosures = [
		{
			subject: { kind: "world_fact", id: "secret" },
			policy: {
				knowers: ["lina"],
				disclosures: [
					{ agentId: "lina", recipientId: "mira" },
					{ agentId: "lina", recipientId: "sol" },
				],
				publication: [],
			},
		},
	];
	const { path, store, service } = setup(pack);
	const reveal = (toAgentId: string) => ({
		...socialIntent(),
		primitives: [
			{
				kind: "reveal",
				claim: { kind: "world_fact", id: "secret" },
				toAgentId,
			},
		],
	});
	await service.resolve(
		socialRequest({ intent: reveal("mira") }),
		new AbortController().signal,
	);
	service.accept("test-world", "request-1");
	await service.resolve(
		socialRequest({
			requestId: "pending-reveal",
			simulationTime: 2,
			intent: reveal("sol"),
		}),
		new AbortController().signal,
	);
	const next = store.worldPack("test-world");
	next.version++;
	next.world.version++;
	next.life.revision++;
	next.life.projection.revision++;
	next.life.projection.disclosures = [];
	updatePack(store, next, "revoke");
	expect(() => service.accept("test-world", "pending-reveal")).toThrow(
		/stale/i,
	);
	store.close();
	const restarted = open(path);
	const world = restarted.snapshot("test-world"),
		life = restarted.lifeSnapshot("test-world"),
		def = restarted.lifeDefinition("test-world");
	const limits = { maxChars: 10000, maxRecords: 100 };
	const view = (agentId: string) =>
		projectLifePerception(
			world,
			life,
			def,
			{ purpose: "life", worldId: "test-world", agentId },
			limits,
		);
	expect(view("mira").facts.some((x) => x.id === "secret")).toBe(true);
	expect(view("sol").facts.some((x) => x.id === "secret")).toBe(false);
	expect(
		projectPublication(
			world,
			life,
			[],
			def.projection,
			{
				purpose: "publication",
				worldId: "test-world",
				agentId: "mira",
				recipientId: "feed",
			},
			limits,
		).facts,
	).toEqual([]);
	expect(restarted.lifeSnapshotAt("test-world", 1).version).toBe(2);
	expect(
		restarted.socialResolution("test-world", "pending-reveal")
			.acceptedLifeRevision,
	).toBeNull();
});

test("competing completed results cannot both consume one source boundary", async () => {
	const { path, store, service } = setup();
	await Promise.all([
		service.resolve(socialRequest(), new AbortController().signal),
		service.resolve(
			socialRequest({ requestId: "competitor" }),
			new AbortController().signal,
		),
	]);
	service.accept("test-world", "request-1");
	expect(() => service.accept("test-world", "competitor")).toThrow(/stale/i);
	store.close();
	const restarted = open(path);
	expect(restarted.lifeSnapshot("test-world").revision).toBe(1);
	expect(
		restarted.socialResolution("test-world", "competitor").acceptedLifeRevision,
	).toBeNull();
});

test("a damaged result or accepted revision fails on actual database reopen", async () => {
	for (const corruption of [
		"checkpoint",
		"receipt",
		"revision",
		"migration",
	] as const) {
		const { path, store, service } = setup();
		await service.resolve(socialRequest(), new AbortController().signal);
		service.accept("test-world", "request-1");
		if (corruption === "migration") {
			const pack = store.worldPack("test-world");
			pack.version++;
			pack.world.version++;
			pack.life.revision++;
			updatePack(store, pack, "changed");
		}
		store.close();
		const raw = new DatabaseSync(path);
		raw.exec("PRAGMA foreign_keys = OFF"); // Synthetic damaged-file injection only.
		try {
			if (corruption === "revision")
				raw.exec(
					"UPDATE world_social_resolutions SET accepted_life_revision = 9007199254740992",
				);
			else if (corruption === "migration") {
				const row = raw
					.prepare(
						"SELECT envelope_json FROM life_commits WHERE life_revision = 2",
					)
					.get() as { envelope_json: string };
				const envelope = JSON.parse(row.envelope_json);
				envelope.socialMigration.toPackVersion = 99;
				const { digest: _digest, ...body } = envelope.socialMigration;
				envelope.socialMigration.digest = lifeDigest(body);
				raw
					.prepare(
						"UPDATE life_commits SET envelope_json = ?, input_digest = ? WHERE life_revision = 2",
					)
					.run(JSON.stringify(envelope), lifeDigest(envelope));
			} else {
				const row = raw
					.prepare("SELECT result_json FROM world_social_resolutions")
					.get() as { result_json: string };
				const result = JSON.parse(row.result_json);
				if (corruption === "checkpoint") {
					result.checkpoint.data.rng.state = 0;
					result.checkpoint.dataDigest = lifeDigest(result.checkpoint.data);
				} else result.requestId = "unrelated";
				const { resultDigest: _digest, ...body } = result;
				result.resultDigest = lifeDigest(body);
				raw
					.prepare(
						"UPDATE world_social_resolutions SET result_json = ?, result_digest = ?",
					)
					.run(JSON.stringify(result), result.resultDigest);
			}
		} finally {
			raw.close();
		}
		expect(() => {
			open(path).close();
		}).toThrow();
	}
});

test("a later reveal preserves an existing false claim and permits only exact legacy retries", async () => {
	const pack = socialPack();
	pack.life.projection.disclosures = [
		{
			subject: { kind: "life_claim", id: "false-claim" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "mira" }],
				publication: [],
			},
		},
	];
	const { path, store, service } = setup(pack);
	const legacy = socialCommit();
	required(legacy.claims[0]).disclosure.knowers = ["lina"];
	store.acceptLife(legacy, identityPolicy());
	const original = JSON.stringify(store.lifeSnapshot("test-world").claims);
	await service.resolve(
		socialRequest({
			simulationTime: 2,
			intent: {
				...socialIntent(),
				primitives: [
					{
						kind: "reveal",
						claim: { kind: "life_claim", id: "false-claim" },
						toAgentId: "mira",
					},
				],
			},
		}),
		new AbortController().signal,
	);
	service.accept("test-world", "request-1");
	expect(store.acceptLife(legacy, identityPolicy()).replayed).toBe(true);
	expect(() =>
		store.acceptLife(
			lifeCommit({
				expectedLifeRevision: 2,
				world: worldActivity({
					idempotencyKey: "downgrade",
					expectedRevision: 2,
					simulationTime: 3,
					facts: [],
				}),
			}),
			identityPolicy(),
		),
	).toThrow(/downgrade/i);
	store.close();
	const restarted = open(path);
	const world = restarted.snapshot("test-world"),
		life = restarted.lifeSnapshot("test-world"),
		definition = restarted.lifeDefinition("test-world");
	expect(JSON.stringify(life.claims)).toBe(original);
	expect(restarted.lifeSnapshotAt("test-world", 1).version).toBe(1);
	const view = projectLifePerception(
		world,
		life,
		definition,
		{ purpose: "life", worldId: "test-world", agentId: "mira" },
		{ maxChars: 10000, maxRecords: 100 },
	);
	expect(view.claims).toContainEqual({
		id: "false-claim",
		text: "The key is red",
	});
	expect(view.beliefs).toEqual([]);
});

test("cancellation after computation leaves the prepared request retryable and accepts no event", async () => {
	const { store, service } = setup();
	const controller = new AbortController(),
		engine = createEnsembleSocialEngine();
	const cancelled = createSocialService({
		store,
		identity: identityPolicy,
		entropy: () => 123456,
		engine: {
			async resolve(input, signal) {
				const result = await engine.resolve(input, signal);
				controller.abort(Error("synthetic cancellation"));
				return result;
			},
		},
	});
	await expect(
		cancelled.resolve(socialRequest(), controller.signal),
	).rejects.toThrow("synthetic cancellation");
	expect(store.lifeSnapshot("test-world").revision).toBe(0);
	expect(store.socialResolution("test-world", "request-1").result).toBeNull();
	expect(
		(await service.resolve(socialRequest(), new AbortController().signal))
			.result?.outcome,
	).toBe("accepted");
	expect(service.accept("test-world", "request-1").lifeRevision).toBe(1);
});

test("an additive predicate and variable keep historical state and resume the real engine", async () => {
	const { path, store, service } = setup();
	await service.resolve(socialRequest(), new AbortController().signal);
	service.accept("test-world", "request-1");
	const before = store.lifeSnapshot("test-world"),
		pack = store.worldPack("test-world");
	if (pack.schemaVersion !== 2) throw Error("Missing social pack");
	pack.version++;
	pack.world.version++;
	pack.life.revision++;
	pack.variables.push({
		id: "weather",
		type: "string",
		initial: "clear",
		min: null,
		max: null,
		knownTo: ["lina", "mira", "sol"],
	});
	pack.predicates.push({
		id: "mood",
		type: "boolean",
		direction: "undirected",
		initial: false,
		min: null,
		max: null,
	});
	pack.social.policies.push({
		predicateId: "mood",
		duration: null,
		visibility: { kind: "first" },
		resource: false,
		attitudeAxisId: null,
	});
	const receipt = updatePack(store, pack, "additions");
	if (receipt.preview.version !== 2) throw Error("Missing migration preview");
	expect(receipt.preview.socialMigration?.operations).toContainEqual({
		kind: "variable_added",
		id: "weather",
	});
	store.close();
	const restarted = open(path);
	expect(restarted.lifeSnapshotAt("test-world", 1)).toEqual(before);
	const checkpoint = restarted.lifeSnapshot("test-world").checkpoint;
	if (checkpoint.engineId !== "ensemble")
		throw Error("Missing social checkpoint");
	expect(checkpoint.data.variables["weather"]).toBe("clear");
	expect(
		checkpoint.data.variableIntroductions.find((x) => x.id === "weather"),
	).toMatchObject({ socialStep: 1, worldRevision: 2 });
	const continued = createSocialService({
		store: restarted,
		engine: createEnsembleSocialEngine(),
		identity: identityPolicy,
	});
	await continued.resolve(
		socialRequest({ requestId: "continued", simulationTime: 2 }),
		new AbortController().signal,
	);
	expect(continued.accept("test-world", "continued").lifeRevision).toBe(3);
});

test("membership migration retires without erasing facts and introduces a new participant at the boundary", async () => {
	const { path, store, service } = setup();
	await service.resolve(socialRequest(), new AbortController().signal);
	service.accept("test-world", "request-1");
	const before = store.lifeSnapshot("test-world"),
		pack = store.worldPack("test-world");
	if (pack.schemaVersion !== 2) throw Error("Missing social pack");
	pack.version++;
	pack.world.version++;
	pack.life.revision++;
	pack.world.agents.push("nova");
	pack.life.participants.push("nova");
	pack.roles.push({
		agentId: "nova",
		roleId: "resident",
		status: "active",
		description: "A new authored participant",
	});
	required(pack.roles.find((x) => x.agentId === "mira")).status = "retired";
	for (const scene of pack.world.scenes)
		scene.occupants = scene.occupants.filter((x) => x !== "mira");
	required(pack.world.scenes.find((x) => x.id === "reading")).occupants.push(
		"nova",
	);
	updatePack(store, pack, "membership", [{ agentId: "mira", sceneId: null }]);
	store.close();
	const restarted = open(path);
	expect(restarted.lifeSnapshotAt("test-world", 1)).toEqual(before);
	const state = restarted.lifeSnapshot("test-world"),
		checkpoint = state.checkpoint;
	if (checkpoint.engineId !== "ensemble")
		throw Error("Missing social checkpoint");
	expect(checkpoint.data.state.offstage).toContain("mira");
	expect(checkpoint.data.state.eliminated).toEqual([]);
	expect(
		checkpoint.data.agentIntroductions.find((x) => x.id === "nova"),
	).toEqual({ id: "nova", socialStep: 1, worldRevision: 2 });
	expect(
		state.attitudes.find(
			(x) => x.fromAgentId === "lina" && x.toAgentId === "mira",
		)?.value,
	).toBe(1);
	const identity = () => {
		const current = identityPolicy();
		current.profiles.push({
			...required(current.profiles[0]),
			agentId: "nova",
		});
		return current;
	};
	const continued = createSocialService({
		store: restarted,
		engine: createEnsembleSocialEngine(),
		identity,
	});
	await expect(
		continued.resolve(
			socialRequest({ requestId: "retired-target", simulationTime: 2 }),
			new AbortController().signal,
		),
	).rejects.toThrow();
	const request = socialRequest({
		requestId: "new-target",
		simulationTime: 2,
		intent: { ...socialIntent(), targetAgentId: "nova" },
		targetResponse: {
			intentId: "intent-1",
			agentId: "nova",
			decision: "accept",
		},
	});
	await continued.resolve(request, new AbortController().signal);
	expect(continued.accept("test-world", "new-target").lifeRevision).toBe(3);
});

test("an active unplaced agent can enter its verified destination and survive restart", async () => {
	const pack = socialPack();
	for (const scene of pack.world.scenes)
		scene.occupants = scene.occupants.filter((x) => x !== "lina");
	const { path, store, service } = setup(pack);
	const request = socialRequest({
		intent: {
			...socialIntent(),
			primitives: [{ kind: "move", sceneId: "meeting" }],
		},
	});
	expect(
		(await service.resolve(request, new AbortController().signal)).result
			?.outcome,
	).toBe("accepted");
	expect(service.accept("test-world", "request-1").lifeRevision).toBe(1);
	store.close();
	const restarted = open(path);
	expect(
		restarted.snapshot("test-world").scenes.find((x) => x.id === "meeting")
			?.occupants,
	).toContain("lina");
});
