import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { PublicationJobs } from "../src/world/publication-jobs.ts";
import { parsePublicationJob } from "../src/world/publication-record-validation.ts";
import type { PublicationJob } from "../src/world/publication-types.ts";
import { WorldStore } from "../src/world/store.ts";
import { authoringPack } from "./life-authoring-fixture.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "./life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
const stores: WorldStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function path() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-pending-source-"));
	roots.push(root);
	return join(root, "world.sqlite");
}
function open(file: string) {
	const store = new WorldStore(file, () => 1000);
	stores.push(store);
	return store;
}
function edit<T>(file: string, action: (db: DatabaseSync) => T): T {
	const db = new DatabaseSync(file);
	try {
		return action(db);
	} finally {
		db.close();
	}
}
function jobRows(file: string) {
	return edit(file, (db) =>
		["life_publication_jobs", "life_publication_job_history"].map((table) =>
			db.prepare(`SELECT * FROM ${table} ORDER BY job_id,revision`).all(),
		),
	);
}
type UnfrozenStatus = "pending" | "failed" | "withheld";
function saveJob(
	file: string,
	version: 1 | 2,
	source: string,
	author: string,
	status: UnfrozenStatus,
) {
	return edit(file, (db) => {
		const jobs = new PublicationJobs(db);
		const initial =
			version === 1
				? jobs.discover("test-world", source, author, "friends")
				: jobs.discoverReply("test-world", source, author, "friends");
		const job =
			status === "pending"
				? initial
				: jobs.withhold(
						"test-world",
						initial.id,
						"source_unavailable",
						status === "failed",
					);
		jobs.validate();
		expect(parsePublicationJob(job)).toEqual(job);
		expect(job.material).toBeNull();
		return job;
	});
}
function published(file: string) {
	const f = preparedPublicationFixture(file);
	stores.push(f.store);
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
				threadId: "synthetic",
				turnId: "turn",
				text: JSON.stringify({
					kind: "post",
					segments: [{ kind: "imaginative", text: "Perhaps tomorrow." }],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		},
	);
	const job = f.store.completePublicationJob(f.lease, f.run.id, f.job.id, {
		author: publicationAuthor,
		modelSettingsRevision: 1,
	});
	if (!job.postId) throw Error("Missing parent fixture post");
	f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
	f.store.releaseLifeLease(f.lease, 1000);
	const { grant } = f.store.mintPublicationViewer("test-world", {
		requestKey: "viewer",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	});
	const principal = { kind: "viewer" as const, grantId: grant.id };
	const reply = f.store.replyToPublication(
		"test-world",
		principal,
		job.postId,
		{
			requestKey: "parent-reply",
			expectedPostRevision: 1,
			text: "A real user reply.",
		},
	);
	if (!reply.postId) throw Error("Missing parent fixture reply");
	return {
		store: f.store,
		postId: job.postId,
		replyId: reply.postId,
		grant,
		principal,
	};
}

for (const status of ["pending", "failed", "withheld"] as const) {
	for (const [version, source, author] of [
		[1, "nonexistent-intent", "lina"],
		[1, "intent", "nonexistent-agent"],
		[2, "nonexistent-parent", "lina"],
		[2, "nonexistent-parent", "nonexistent-agent"],
	] as const) {
		test(`reopen rejects hashed v${version} ${status} job with ${source}/${author}`, () => {
			const file = path(),
				store = publicationStoreFixture(file);
			store.close();
			saveJob(file, version, source, author, status);
			const before = jobRows(file);
			expect(() => {
				open(file);
			}).toThrow(/publication (intent|author|parent)/i);
			expect(jobRows(file)).toEqual(before);
		});
	}
	for (const parent of ["postId", "replyId"] as const) {
		test(`reopen rejects ${status} reply with a real ${parent} and an author defined only in another world`, () => {
			const file = path(),
				f = published(file);
			f.store.create({
				...worldDefinition("other-world"),
				agents: ["lina", "mira", "sol", "outsider"],
			});
			f.store.close();
			saveJob(file, 2, f[parent], "outsider", status);
			expect(() => {
				open(file);
			}).toThrow(/publication author/i);
		});
	}
}

test("reopen rejects a validly hashed event intent naming a nonexistent event before material freeze", () => {
	const file = path(),
		store = publicationStoreFixture(file);
	store.close();
	saveJob(file, 1, "intent", "lina", "pending");
	edit(file, (db) => {
		const row = db
			.prepare("SELECT intent_json FROM life_effects WHERE intent_id='intent'")
			.get();
		const intent = JSON.parse(String(row?.["intent_json"]));
		intent.payload.eventId = "test-world:999";
		intent.payloadDigest = lifeDigest(intent.payload);
		db.prepare(
			"UPDATE life_effects SET intent_json=?,payload_digest=? WHERE intent_id='intent'",
		).run(canonicalLifeJson(intent), intent.payloadDigest);
	});
	const before = jobRows(file);
	expect(() => {
		open(file);
	}).toThrow();
	expect(jobRows(file)).toEqual(before);
});

function activate(store: WorldStore, retired: string[] = []) {
	const world = store.snapshot("test-world"),
		pack = authoringPack();
	pack.world = {
		...world.definition,
		version: world.definition.version + (retired.length ? 1 : 0),
	};
	pack.version = pack.world.version;
	pack.life = store.lifeDefinition("test-world");
	if (retired.length) {
		pack.life.revision++;
		for (const role of pack.roles)
			if (retired.includes(role.agentId)) role.status = "retired";
		for (const scene of pack.world.scenes)
			scene.occupants = scene.occupants.filter((id) => !retired.includes(id));
	}
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
		agentId: "sol",
		targetAgentId: null,
		seed: "pending-source-retirement",
		limits: {
			maxChars: 2000,
			maxRecords: 20,
			maxDepth: 4,
			maxOperations: 1000,
		},
		relocations: retired.map((agentId) => ({ agentId, sceneId: null })),
	};
	const preview = store.previewWorldDraft(edited.id, edited.revision, options);
	if (!preview.packDigest) throw Error("Missing authored fixture digest");
	store.activateWorldDraft({
		draftId: edited.id,
		expectedRevision: edited.revision,
		idempotencyKey: `activate-${pack.version}`,
		packDigest: preview.packDigest,
		previewDigest: preview.digest,
		options,
	});
}

test.each(["pending", "failed", "withheld"] as const)(
	"retirement and publication permission removal preserve a sourced unfrozen v1 %s job",
	(status) => {
		const file = path(),
			store = publicationStoreFixture(file);
		stores.push(store);
		expect(
			store.publicationMaterial("test-world", "intent", "lina", ["friends"], {
				maxChars: 20000,
				maxRecords: 100,
			}),
		).not.toBeNull();
		const job = saveJob(file, 1, "intent", "lina", status);
		activate(store);
		activate(store, ["lina"]);
		const {
			worldId: _worldId,
			revision,
			...config
		} = store.lifeConfig("test-world");
		store.setLifeConfig("test-world", revision, {
			...config,
			publication: null,
		});
		store.close();
		const before = jobRows(file),
			reopened = open(file);
		expect(reopened.publicationJob("test-world", job.id)).toEqual(job);
		expect(jobRows(file)).toEqual(before);
	},
);

test.each(["pending", "failed", "withheld"] as const)(
	"retired author and withdrawn source parents preserve real unfrozen %s jobs on reopen",
	(status) => {
		const file = path(),
			f = published(file);
		const settings = f.store.publicationSettings("test-world");
		if (!settings) throw Error("Missing publication fixture settings");
		const { worldId: _worldId, revision, ...input } = settings;
		f.store.setPublicationSettings("test-world", revision, {
			...input,
			agentRecipients: [
				{ agentId: "lina", recipientId: "friends" },
				{ agentId: "mira", recipientId: "friends" },
			],
		});
		const expected: PublicationJob[] = [
			saveJob(file, 2, f.postId, "mira", status),
			saveJob(file, 2, f.replyId, "lina", status),
		];
		for (const [parentId, author] of [
			[f.postId, "mira"],
			[f.replyId, "lina"],
		] as const)
			expect(
				f.store.publicationPost(
					"test-world",
					{ kind: "agent", agentId: author },
					parentId,
				),
			).not.toBeNull();
		activate(f.store);
		activate(f.store, ["lina", "mira"]);
		expect(f.store.activePublicationAgents("test-world")).not.toContain("lina");
		for (const postId of [f.postId, f.replyId])
			f.store.withdrawPublicationPost("test-world", postId, {
				requestKey: `withdraw-${postId}`,
				expectedRevision: 1,
			});
		f.store.revokePublicationViewer("test-world", f.grant.id, {
			requestKey: "revoke",
			expectedRevision: 1,
		});
		f.store.close();
		const before = jobRows(file),
			reopened = open(file);
		for (const job of expected)
			expect(reopened.publicationJob("test-world", job.id)).toEqual(job);
		expect(jobRows(file)).toEqual(before);
	},
);
