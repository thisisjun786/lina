import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorldPreviewOptions } from "../src/world/authoring-types.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../src/world/publication-model.ts";
import type { PublicationJob } from "../src/world/publication-types.ts";
import { WorldStore } from "../src/world/store.ts";
import { authoringPack } from "./life-authoring-fixture.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw Error("Missing retirement fixture value");
	return value;
}
const roots: string[] = [],
	stores: WorldStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function databasePath() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-retirement-"));
	roots.push(root);
	return join(root, "world.sqlite");
}
function legacySource(path: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db
			.prepare("SELECT envelope_json FROM life_commits WHERE life_revision=1")
			.get();
	} finally {
		db.close();
	}
}
function activate(store: WorldStore, retired: string[] = []) {
	const world = store.snapshot("test-world"),
		pack = authoringPack();
	pack.world = {
		...world.definition,
		version: world.definition.version + (retired.length ? 1 : 0),
	};
	pack.version = pack.world.version;
	pack.life = store.lifeDefinition(pack.worldId);
	if (retired.length) pack.life.revision++;
	for (const role of pack.roles)
		role.status = retired.includes(role.agentId) ? "retired" : "active";
	for (const scene of pack.world.scenes)
		scene.occupants = scene.occupants.filter((id) => !retired.includes(id));
	const draft = store.draftWorld({
		worldId: pack.worldId,
		authoredText: pack.background.authoredText,
	});
	const edited = store.editWorldDraft(draft.id, draft.revision, {
		authoredText: draft.authoredText,
		pack,
	});
	const options: WorldPreviewOptions = {
		expectedWorldRevision: world.revision,
		simulationTime: world.simulationTime,
		agentId: "mira",
		targetAgentId: null,
		seed: "retirement",
		limits: {
			maxChars: 2000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 1000,
		},
		relocations: retired.map((agentId) => ({ agentId, sceneId: null })),
	};
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	store.activateWorldDraft({
		draftId: edited.id,
		expectedRevision: edited.revision,
		idempotencyKey: `activate-${pack.version}`,
		packDigest: required(preview.packDigest),
		previewDigest: preview.digest,
		options,
	});
	expect(
		store
			.worldPack(pack.worldId)
			.roles.filter((r) => r.status === "retired")
			.map((r) => r.agentId),
	).toEqual(retired);
	return pack;
}
function finish(
	f: Omit<ReturnType<typeof preparedPublicationFixture>, "job"> & {
		job: PublicationJob;
	},
	dispatch = true,
) {
	if (dispatch)
		f.store.dispatchPublicationModel(
			f.lease,
			f.run.id,
			f.job.id,
			f.prepared.request.id,
		);
	f.store.finishPublicationModel(
		"test-world",
		f.job.id,
		f.prepared.request.id,
		{
			status: "completed",
			result: {
				version: 1,
				requestId: f.prepared.request.id,
				inputDigest: f.prepared.inputDigest,
				capabilityFingerprint: f.prepared.capabilityFingerprint,
				nativeReference: f.prepared.nativeReference,
				provider: "synthetic",
				model: "narrator",
				threadId: "thread",
				turnId: "turn",
				text: JSON.stringify({
					kind: "post",
					segments: [
						{
							kind: "claim",
							claimId: required(f.job.material?.allowedClaims[0]).id,
						},
					],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		},
	);
}
const input = {
	requestKey: "retired-run",
	expectedConfigRevision: 1,
	expectedSettingsRevision: 1,
	mode: "manual" as const,
};
const page = { limit: 10, after: null };

test("retired generated authors disappear from current feeds and descendant selection while exact history reopens", () => {
	const path = databasePath(),
		f = preparedPublicationFixture(path);
	stores.push(f.store);
	finish(f);
	const published = f.store.completePublicationJob(
		f.lease,
		f.run.id,
		f.job.id,
		{ author: publicationAuthor, modelSettingsRevision: 1 },
	);
	f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
	const postId = required(published.postId),
		{ grant } = f.store.mintPublicationViewer("test-world", {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
	const principal = { kind: "viewer" as const, grantId: grant.id };
	f.store.resharePublication("test-world", principal, postId, {
		requestKey: "share",
		expectedPostRevision: 1,
	});
	const input = required(f.store.automaticPublicationInput("test-world"));
	const run = f.store.beginPublicationRun("test-world", input, "owner", 100),
		lease = required(run.lease),
		item = required(run.batch[0]);
	const job = f.store.freezePublicationJob(
		lease,
		run.id,
		item.jobId,
		publicationAuthor,
		1,
	);
	expect(job.version).toBe(2);
	const request = {
		...f.prepared.request,
		id: publicationModelId(job.attemptId),
		jobId: job.id,
		...buildPublicationModelInput(job),
	};
	const prepared = {
		...f.prepared,
		request,
		inputDigest: lifeDigest(request),
		nativeReference: "retirement-reply",
	};
	f.store.preparePublicationModel(lease, run.id, prepared);
	finish({ ...f, job, lease, run, prepared });
	const completed = f.store.completePublicationJob(lease, run.id, job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		}),
		replyId = required(completed.postId);
	f.store.advancePublicationRun(lease, run.id, job.id);
	f.store.releaseLifeLease(lease, 1000);
	const {
		worldId: _world,
		revision,
		...settings
	} = required(f.store.publicationSettings("test-world"));
	f.store.setPublicationSettings("test-world", revision, {
		...settings,
		agentRecipients: [
			{ agentId: "lina", recipientId: "friends" },
			{ agentId: "mira", recipientId: "friends" },
		],
	});
	activate(f.store);
	expect(
		f.store.publicationPost("test-world", principal, replyId),
	).not.toBeNull();
	activate(f.store, ["lina"]);
	expect(
		f.store.publicationPost("test-world", principal, postId),
	).not.toBeNull();
	expect(f.store.publicationPost("test-world", principal, replyId)).toBeNull();
	expect(
		f.store
			.publicationFeed("test-world", principal, page)
			.items.some((post) => post.id === replyId),
	).toBe(false);
	expect(
		f.store.publicationReplyMaterial("test-world", replyId, "mira", "friends", {
			maxChars: 20000,
			maxRecords: 100,
		}),
	).toBeNull();
	f.store.close();
	const reopened = new WorldStore(path, () => 1000);
	stores.push(reopened);
	expect(reopened.publicationJob("test-world", completed.id)).toEqual(
		completed,
	);
	expect(reopened.publicationPost("test-world", principal, replyId)).toBeNull();
});

test("current authored retirement excludes discovery and the read-only automatic candidate probe", () => {
	const store = publicationStoreFixture(databasePath());
	stores.push(store);
	activate(store);
	expect(store.automaticPublicationInput("test-world")).not.toBeNull();
	activate(store, ["lina"]);
	expect(store.lifeDefinition("test-world").participants).toContain("lina");
	expect(store.activePublicationAgents("test-world")).toEqual(["mira", "sol"]);
	expect(
		store.publicationMaterial("test-world", "intent", "lina", ["friends"], {
			maxChars: 20000,
			maxRecords: 100,
		}),
	).toBeNull();
	expect(store.automaticPublicationInput("test-world")).toBeNull();
	expect(
		store.beginPublicationRun("test-world", input, "owner", 100).batch,
	).toEqual([]);
	expect(store.pendingPublicationRuns("test-world")).toEqual([]);
});

test("an actually retired author cannot freeze or dispatch prepared work, including after reopen", () => {
	const path = databasePath(),
		f = preparedPublicationFixture(path);
	stores.push(f.store);
	activate(f.store);
	activate(f.store, ["lina"]);
	expect(() =>
		f.store.assertPublicationDispatch(
			"test-world",
			f.job.id,
			publicationAuthor,
			1,
		),
	).toThrow();
	f.store.close();
	const reopened = new WorldStore(path, () => 1000);
	stores.push(reopened);
	const run = reopened.beginPublicationRun(
		"test-world",
		f.run.input,
		"owner",
		100,
	);
	expect(() =>
		reopened.freezePublicationJob(
			required(run.lease),
			run.id,
			f.job.id,
			publicationAuthor,
			1,
		),
	).toThrow();
	expect(
		reopened.publicationModelRecords("test-world", f.job.id)[0]?.status,
	).toBe("prepared");
});

test("unknown dispatch reconciles after authored retirement and reopen without another dispatch or a new post", () => {
	const path = databasePath(),
		f = preparedPublicationFixture(path);
	stores.push(f.store);
	activate(f.store);
	f.store.dispatchPublicationModel(
		f.lease,
		f.run.id,
		f.job.id,
		f.prepared.request.id,
	);
	f.store.finishPublicationModel(
		"test-world",
		f.job.id,
		f.prepared.request.id,
		{ status: "unknown" },
	);
	const config = f.store.lifeConfig("test-world");
	activate(f.store, ["lina"]);
	f.store.close();
	const reopened = new WorldStore(path, () => 1000);
	stores.push(reopened);
	expect(
		reopened.publicationModelRecords("test-world", f.job.id)[0]?.status,
	).toBe("unknown");
	finish({ ...f, store: reopened }, false);
	const run = reopened.beginPublicationRun(
		"test-world",
		f.run.input,
		"owner",
		100,
	);
	expect(
		reopened.completePublicationJob(required(run.lease), run.id, f.job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		}).status,
	).toBe("withheld");
	expect(
		reopened.publicationModelRecords("test-world", f.job.id)[0],
	).toMatchObject({
		status: "completed",
		usage: { totalTokens: 15 },
		upstreamAttempts: 1,
	});
	expect(reopened.publicationJob("test-world", f.job.id).postId).toBeNull();
	expect(reopened.lifeConfig("test-world")).toEqual(config);
});

test("retired agent loses feed, cursor and interaction access while viewer history and active observations persist", () => {
	const path = databasePath(),
		f = preparedPublicationFixture(path);
	stores.push(f.store);
	finish(f);
	const published = f.store.completePublicationJob(
		f.lease,
		f.run.id,
		f.job.id,
		{ author: publicationAuthor, modelSettingsRevision: 1 },
	);
	const postId = required(published.postId);
	f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
	const {
		worldId: _w,
		revision: _r,
		...settings
	} = required(f.store.publicationSettings("test-world"));
	f.store.setPublicationSettings("test-world", 1, {
		...settings,
		agentRecipients: [
			{ agentId: "lina", recipientId: "friends" },
			{ agentId: "mira", recipientId: "friends" },
		],
	});
	const minted = f.store.mintPublicationViewer("test-world", {
		requestKey: "viewer",
		expectedSettingsRevision: 2,
		recipientId: "friends",
	});
	const grant = required(
		f.store.authenticatePublicationViewer("test-world", required(minted.token)),
	);
	const viewer = { kind: "viewer" as const, grantId: grant.id };
	const agent = { kind: "agent" as const, agentId: "lina" };
	const original = f.store.publicationPost("test-world", viewer, postId);
	activate(f.store);
	expect(f.store.publicationPost("test-world", agent, postId)).toEqual(
		original,
	);
	f.store.setPublicationReadCursor("test-world", agent, {
		expectedRevision: 0,
		postId,
	});
	const reply = {
		requestKey: "before",
		expectedPostRevision: 1,
		text: "Before retirement",
	};
	f.store.replyToPublication("test-world", viewer, postId, reply);
	const oldInputs = f.store.lifeInputs("test-world");
	expect(oldInputs).toHaveLength(2);
	const v1 = legacySource(path);
	expect(v1).toBeDefined();
	activate(f.store, ["lina"]);
	expect(f.store.publicationPost("test-world", viewer, postId)).toEqual(
		original,
	);
	expect(() => f.store.publicationFeed("test-world", agent, page)).toThrow(
		"Publication principal forbidden",
	);
	expect(() => f.store.publicationPost("test-world", agent, postId)).toThrow(
		"Publication principal forbidden",
	);
	expect(() => f.store.publicationReadCursor("test-world", agent)).toThrow(
		"Publication principal forbidden",
	);
	expect(() =>
		f.store.replyToPublication("test-world", agent, postId, {
			...reply,
			requestKey: "retired",
		}),
	).toThrow("Publication principal forbidden");
	f.store.replyToPublication("test-world", viewer, postId, {
		...reply,
		requestKey: "after",
	});
	const newInputs = f.store
		.lifeInputs("test-world")
		.filter((row) => !oldInputs.some((old) => old.id === row.id));
	expect(newInputs).toHaveLength(1);
	expect(newInputs[0]?.source).toMatchObject({
		kind: "publication_interaction",
		recipientAgentId: "mira",
	});
	expect(legacySource(path)).toEqual(v1);
	f.store.close();
	const reopened = new WorldStore(path, () => 1000);
	stores.push(reopened);
	expect(reopened.publicationPost("test-world", viewer, postId)).toEqual(
		original,
	);
	expect(
		reopened.lifeInputs("test-world").sort((a, b) => a.id.localeCompare(b.id)),
	).toEqual(
		[...oldInputs, ...newInputs].sort((a, b) => a.id.localeCompare(b.id)),
	);
	expect(reopened.publicationJob("test-world", f.job.id)).toEqual(published);
	expect(legacySource(path)).toEqual(v1);
	expect(() => reopened.publicationFeed("test-world", agent, page)).toThrow(
		"Publication principal forbidden",
	);
	const wire = JSON.stringify(
		reopened.publicationFeed("test-world", viewer, page),
	);
	for (const hidden of [
		"hidden key",
		"whispered",
		"A quiet meeting",
		"Test garden",
		"The key is red",
	])
		expect(wire).not.toContain(hidden);
});

test("current authored corruption fails closed instead of enabling the legacy participant fallback", () => {
	const path = databasePath(),
		store = publicationStoreFixture(path);
	stores.push(store);
	const pack = activate(store);
	const db = new DatabaseSync(path);
	try {
		db.prepare("UPDATE world_packs SET digest=? WHERE version=?").run(
			"0".repeat(64),
			pack.version,
		);
	} finally {
		db.close();
	}
	expect(() =>
		store.publicationFeed(
			"test-world",
			{ kind: "agent", agentId: "lina" },
			page,
		),
	).toThrow(/Corrupt world pack/);
	expect(() =>
		store.beginPublicationRun("test-world", input, "owner", 100),
	).toThrow(/Corrupt world pack/);
});
