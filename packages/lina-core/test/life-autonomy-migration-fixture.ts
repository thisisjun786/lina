import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorldPack } from "../src/world/authoring-types.ts";
import { parseAutonomyState } from "../src/world/autonomy-validation.ts";
import { WorldStore } from "../src/world/store.ts";
import { literal, rule } from "./life-authoring-fixture.ts";
import { autonomyPack, autonomySource } from "./life-autonomy-pure-fixture.ts";

export function migrationFixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-autonomy-migration-")),
		path = join(root, "world.sqlite"),
		clock = () => 1000,
		store = new WorldStore(path, clock),
		source = autonomySource(),
		pack = autonomyPack();
	pack.autonomy.events = [];
	pack.autonomy.quietWeight = 1;
	pack.rules = [
		rule("accepted-variable", {
			effects: [{ kind: "assign", variableId: "count", value: literal(7) }],
		}),
	];
	const request = {
		worldId: pack.worldId,
		idempotencyKey: "quiet",
		expectedConfigRevision: 1,
		owner: "fixture",
		nowMs: 1000,
		leaseMs: 10000,
		identity: source.identity,
		profiles: source.profiles,
		modelSettingsRevision: 1,
	};
	return {
		store,
		path,
		clock,
		source,
		pack,
		request,
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
export function proposePack(store: WorldStore, pack: WorldPack) {
	const current = store
		.worldCatalog({ afterId: null, limit: 10 })
		.items.find((x) => x.worldId === pack.worldId);
	const draft = store.draftWorld({
			worldId: pack.worldId,
			authoredText: pack.background.authoredText,
		}),
		edited = store.editWorldDraft(draft.id, draft.revision, {
			authoredText: draft.authoredText,
			pack,
		});
	const options = {
		expectedWorldRevision: current?.worldRevision ?? null,
		simulationTime: current
			? store.snapshot(pack.worldId).simulationTime
			: pack.world.initialTime,
		agentId: "lina",
		targetAgentId: null,
		seed: "migration",
		limits: {
			maxChars: 20000,
			maxRecords: 50,
			maxDepth: 8,
			maxOperations: 10000,
		},
		relocations: [],
	};
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	if (!preview.packDigest) throw Error("fixture preview");
	return {
		preview,
		confirmation: {
			draftId: edited.id,
			expectedRevision: edited.revision,
			idempotencyKey: `activate-${pack.version}`,
			packDigest: preview.packDigest,
			previewDigest: preview.digest,
			options,
		},
	};
}
export function activateBaseline(f: ReturnType<typeof migrationFixture>) {
	const p = proposePack(f.store, f.pack);
	const receipt = f.store.activateWorldDraft(p.confirmation);
	const { worldId: _, revision: __, ...config } = f.source.config;
	f.store.setLifeConfig(f.pack.worldId, 0, config);
	return receipt;
}
export function acceptQuiet(f: ReturnType<typeof migrationFixture>) {
	const step = f.store.prepareLifeStep(f.request, () => 42);
	f.store.prepareLifeObservations(step.lease, step.id, null, 1000);
	f.store.finishLifeStep(step.lease, step.id, 1000);
	f.store.acceptLifeStep(
		step.lease,
		step.id,
		{ identity: f.source.identity, modelSettingsRevision: 1 },
		1000,
	);
	return f.store.lifeStep(step.worldId, step.id);
}
export function sidecar(path: string) {
	const db = new DatabaseSync(path);
	try {
		const row = db
			.prepare("SELECT state_json FROM life_autonomy_state")
			.get() as { state_json: string } | undefined;
		if (!row) throw Error("Missing fixture autonomy state");
		return parseAutonomyState(JSON.parse(row.state_json));
	} finally {
		db.close();
	}
}
export function nextPack(f: ReturnType<typeof migrationFixture>) {
	const pack = structuredClone(f.pack);
	pack.version = 2;
	pack.world.version = 2;
	pack.life.revision = 2;
	pack.autonomy.needs.push({
		id: "new-need",
		label: "A new need",
		min: 0,
		max: 10,
		initial: 9,
		driftPerStep: 0,
	});
	pack.variables.push({
		id: "new-variable",
		type: "number",
		initial: 9,
		min: 0,
		max: 10,
		knownTo: ["lina", "mira", "sol"],
	});
	return pack;
}
