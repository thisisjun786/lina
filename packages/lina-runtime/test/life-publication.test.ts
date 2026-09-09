/**
 * Scoped 060 TDD evidence, 2026-09-08, Bun 1.4.0 (34cbb9a40).
 * Initial RED before production edits:
 * bun test packages/lina-runtime/test/life-publication.test.ts
 * 0 pass, 4 fail, exit 1: TypeError: f.runner.publish is not a function.
 * First GREEN of those same four tests: 4 pass, 0 fail, exit 0.
 * Returned-usage cancellation regression RED/GREEN:
 * bun test packages/lina-runtime/test/life-publication.test.ts -t 'a returned result'
 * RED: 0 pass, 1 fail, exit 1 (inputTokens 0 instead of 11; unknownRequests 1).
 * GREEN: 1 pass, 0 fail, exit 0 (known usage retained despite unavailable journal).
 * All fixtures are synthetic; these tests do not qualify a live native/provider route.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifeModelReceipts } from "../../lina-core/src/world/autonomy-model-receipts.ts";
import type {
	LifeModelRequest,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { PublicationJobs } from "../../lina-core/src/world/publication-jobs.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../lina-core/src/world/publication-model.ts";
import type { PublicationRunInput } from "../../lina-core/src/world/publication-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { autonomySource } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import {
	identityPolicy,
	lifeCommit,
} from "../../lina-core/test/life-fixture.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "../../lina-core/test/life-publication-store-fixture.ts";
import { worldActivity } from "../../lina-core/test/world-fixture.ts";
import { visitLifePublication } from "../src/life/publication-scheduler.ts";
import {
	createLifeRunner,
	type LifeRunnerOptions,
} from "../src/life/runner.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import { ModelRequestError } from "../src/models/errors.ts";
import {
	deferred,
	RuntimeClock,
	RuntimeForeground,
	RuntimeModel,
} from "./life-runtime-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const worldId = "test-world";
const signal = () => new AbortController().signal;
test("missing shared model configuration preserves a publication job for configuration repair", async () => {
	const f = fixture();
	if (!f.options.publication) throw Error("Missing publication fixture");
	f.options.publication.resolveModel = () => {
		throw new ModelRequestError(
			"LIFE requires a shared tier",
			"not_configured",
		);
	};
	await expect(
		f.runner.publish(worldId, f.input(), signal()),
	).rejects.toMatchObject({ code: "not_configured" });
	const run = f.store.pendingPublicationRuns(worldId)[0];
	const item = run?.batch[0];
	if (!item) throw Error("Missing recoverable batch");
	expect(f.store.publicationJob(worldId, item.jobId).status).toBe("pending");
	expect(f.model.requests).toHaveLength(0);
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

class PublicationModel extends RuntimeModel {
	reconciled: PreparedLifeModelRequest[] = [];
	onPrepare?: (request: LifeModelRequest, signal: AbortSignal) => Promise<void>;
	override async prepare(request: LifeModelRequest, signal: AbortSignal) {
		await this.onPrepare?.(request, signal);
		return super.prepare(request, signal);
	}
	override async reconcile(request: PreparedLifeModelRequest) {
		this.reconciled.push(request);
		return super.reconcile(request);
	}
}

test("a reply whose last chain slot is spent during model preparation is fenced before provider completion", async () => {
	const f = fixture();
	const saved = f.store.publicationSettings(worldId);
	if (!saved) throw Error("Missing settings");
	const { worldId: _world, revision, ...settings } = saved;
	f.store.setPublicationSettings(worldId, revision, {
		...settings,
		reactionIds: ["like"],
		maxActionsPerChain: 3,
	});
	f.model.text = () =>
		JSON.stringify({
			kind: "post",
			segments: [{ kind: "imaginative", text: "A public moment." }],
		});
	const first = await f.runner.publish(worldId, f.input("root"), signal()),
		item = first.batch[0];
	if (!item) throw Error("Missing rootjob");
	const postId = f.store.publicationJob(worldId, item.jobId).postId;
	if (!postId) throw Error("Missing rootpost");
	const { grant } = f.store.mintPublicationViewer(worldId, {
		requestKey: "viewer",
		expectedSettingsRevision: 2,
		recipientId: "friends",
	});
	const principal = { kind: "viewer" as const, grantId: grant.id };
	f.store.replyToPublication(worldId, principal, postId, {
		requestKey: "reply",
		expectedPostRevision: 1,
		text: "Would you reply?",
	});
	f.model.onPrepare = async () => {
		f.store.reactToPublication(worldId, principal, postId, {
			requestKey: "last-slot",
			expectedPostRevision: 1,
			reactionId: "like",
			active: true,
		});
	};
	const run = await f.runner.publish(worldId, f.input("reply"), signal());
	expect(f.model.requests).toHaveLength(1);
	expect(run.outcomes).toEqual(["failed"]);
	const reply = run.batch[0];
	if (!reply) throw Error("Missing replyjob");
	expect(
		f.store.publicationModelRecords(worldId, reply.jobId)[0],
	).toMatchObject({ status: "failed", upstreamAttempts: 0 });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-runner-"));
	const path = join(root, "world.sqlite");
	publicationStoreFixture(path).close();
	const clock = new RuntimeClock();
	clock.time = 1000;
	let store = new WorldStore(path, () => clock.now());
	const db = new DatabaseSync(path);
	const receipts = new LifeModelReceipts(db, () => clock.now(), "publication");
	const status = () => store.publicationExecutionStatus(worldId);
	const model = new PublicationModel();
	model.text = () => '{"kind":"no_post"}';
	const foreground = new RuntimeForeground();
	const source = autonomySource();
	let author = structuredClone(publicationAuthor);
	const publication = {
		store,
		author: () => structuredClone(author),
	};
	const options: LifeRunnerOptions = {
		store,
		model,
		clock,
		foreground,
		publication,
		engine: createEnsembleSocialEngine(),
		identity: () => ({
			identity: source.identity,
			profiles: source.profiles,
			modelSettingsRevision: 7,
		}),
		owner: "publication-runner",
		leaseMs: 300,
		entropy: () => 42,
	};
	let runner = createLifeRunner(options);
	const f = {
		get store() {
			return store;
		},
		get runner() {
			return runner;
		},
		model,
		clock,
		foreground,
		options,
		receipts,
		status,
		db,
		path,
		changeAuthor() {
			author = { ...author, profileRevision: author.profileRevision + 1 };
		},
		input(
			key = "run",
			mode: PublicationRunInput["mode"] = "manual",
		): PublicationRunInput {
			return {
				requestKey: key,
				mode,
				expectedConfigRevision: store.lifeConfig(worldId).revision,
				expectedSettingsRevision:
					store.publicationSettings(worldId)?.revision ?? 0,
			};
		},
		async reopen() {
			await runner.close();
			store.close();
			store = new WorldStore(path, () => clock.now());
			options.store = store;
			publication.store = store;
			runner = createLifeRunner(options);
		},
	};
	cleanups.push(async () => {
		await runner.close();
		store.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	return f;
}

/** A real accepted source without current disclosure, as a revoked queued job may have. */
function queueLaterIntent(f: ReturnType<typeof fixture>, intentId: string) {
	const life = f.store.lifeSnapshot(worldId);
	const payload = {
		kind: "publication_candidate" as const,
		eventId: `${worldId}:${life.worldRevision + 1}`,
	};
	f.store.acceptLife(
		lifeCommit({
			expectedLifeRevision: life.revision,
			definitionRevision: life.definitionRevision,
			world: worldActivity({
				idempotencyKey: intentId,
				expectedRevision: life.worldRevision,
				simulationTime: life.revision + 1,
				facts: [],
			}),
			effects: [
				{
					version: 1,
					worldId,
					id: intentId,
					lifeRevision: life.revision + 1,
					payload,
					payloadDigest: lifeDigest(payload),
				},
			],
		}),
		identityPolicy(),
	);
	return new PublicationJobs(f.db).discover(
		worldId,
		intentId,
		"lina",
		"friends",
	);
}

test("publication uses the shared model and lease, persists no_post, and terminal replay reopens without inference", async () => {
	const f = fixture(),
		input = f.input();
	const first = await f.runner.publish(worldId, input, signal());
	expect(first.status).toBe("completed");
	expect(first.outcomes).toEqual(["skipped"]);
	expect(f.model.requests).toHaveLength(1);
	expect(f.model.requests[0]).toMatchObject({
		version: 2,
		lane: "publication",
		modelSettingsRevision: 7,
	});
	expect(f.model.requests[0]).not.toHaveProperty("stepId");
	expect(f.status().usage.inputTokens).toBe(11);
	expect(f.status().schedule?.lease).toBeNull();
	expect(f.clock.pending).toBe(0);
	await f.reopen();
	expect(await f.runner.publish(worldId, input, signal())).toEqual(first);
	expect(f.model.requests).toHaveLength(1);
	expect(f.model.reconciled).toHaveLength(0);
});

test("publication has explicit optional configuration", async () => {
	const f = fixture();
	const { publication: _publication, ...options } = f.options;
	const runner = createLifeRunner(options);
	try {
		await expect(
			runner.publish(worldId, f.input(), signal()),
		).rejects.toMatchObject({ status: "not_configured" });
		expect(f.model.prepared).toHaveLength(0);
	} finally {
		await runner.close();
	}
});

test("run and publish share admission while native preparation is awaiting", async () => {
	const f = fixture(),
		entered = deferred<void>(),
		release = deferred<void>();
	f.model.onPrepare = async () => {
		entered.resolve();
		await release.promise;
	};
	const publishing = f.runner.publish(worldId, f.input(), signal());
	await entered.promise;
	try {
		await expect(
			f.runner.run(worldId, "simulation", 1, signal()),
		).rejects.toMatchObject({ status: "busy" });
		await expect(
			f.runner.publish(worldId, f.input(), signal()),
		).rejects.toMatchObject({ status: "busy" });
	} finally {
		release.resolve();
	}
	expect((await publishing).status).toBe("completed");
});

test("paused automatic publication is durably blocked but explicit manual publication completes", async () => {
	const f = fixture();
	const { worldId: _w, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		run: { mode: "paused" },
	});
	const blocked = await f.runner.publish(
		worldId,
		f.input("auto", "automatic"),
		signal(),
	);
	expect(blocked.blocked).toBe("paused");
	expect(f.model.prepared).toHaveLength(0);
	expect(
		(await f.runner.publish(worldId, f.input("manual"), signal())).outcomes,
	).toEqual(["skipped"]);
});

async function preparedFixture(
	mode: PublicationRunInput["mode"] = "manual",
	configure?: (f: ReturnType<typeof fixture>) => void,
) {
	const f = fixture();
	configure?.(f);
	const input = f.input("recover", mode);
	const run = f.store.beginPublicationRun(
		worldId,
		input,
		"crashed-worker",
		300,
	);
	const item = run.batch[0],
		lease = run.lease;
	if (!item || !lease) throw Error("Missing frozen fixture batch");
	const job = f.store.freezePublicationJob(
		lease,
		run.id,
		item.jobId,
		publicationAuthor,
		7,
	);
	const prepared = await f.model.prepare(
		{
			version: 2,
			id: publicationModelId(job.attemptId),
			worldId,
			jobId: job.id,
			lane: "publication",
			agentId: job.authorAgentId,
			provider: "synthetic",
			model: "narrator",
			modelSettingsRevision: 7,
			...buildPublicationModelInput(job),
			limits: {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 80000,
				maxOutputBytes: 80000,
				timeoutMs: 1000,
			},
		},
		signal(),
	);
	f.store.preparePublicationModel(lease, run.id, prepared);
	f.store.releaseLifeLease(lease, f.clock.now());
	return { f, input, run, job, prepared };
}

function restrictScheduledPublication(
	f: ReturnType<typeof fixture>,
	change: "paused" | "manual_publication" | "both",
) {
	const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
	f.store.setLifeConfig(worldId, revision, {
		...config,
		run: { mode: change === "manual_publication" ? "manual" : "paused" },
		publication: {
			mode: change === "paused" ? "automatic" : "manual",
			recipientIds: ["friends"],
		},
	});
}

test.each(["paused", "manual_publication", "both"] as const)(
	"scheduled recovery cannot dispatch a saved manual preparation while %s",
	async (change) => {
		const { f, input, job, prepared } = await preparedFixture();
		restrictScheduledPublication(f, change);
		await f.reopen();
		expect(f.store.automaticPublicationInput(worldId)).toEqual(input);
		expect(await visitLifePublication(f, worldId, signal())).toBeNull();
		expect(f.model.reconciled).toEqual([prepared]);
		expect(f.model.requests).toHaveLength(0);
		expect(f.model.prepared).toHaveLength(1);
		expect(f.store.publicationJob(worldId, job.id).status).toBe("prepared");
		expect(f.store.publicationJob(worldId, job.id).postId).toBeNull();
		expect(f.status().usage.reservedInputTokens).toBe(100);
		expect(f.status().schedule?.lease).toBeNull();
		expect(f.clock.pending).toBe(0);
	},
);

test("scheduled recovery of saved manual unknown usage keeps a ready post paused until explicit manual completion once", async () => {
	const { f, input, run, job, prepared } = await preparedFixture(
		"manual",
		(f) => restrictScheduledPublication(f, "both"),
	);
	const recovered = f.store.beginPublicationRun(
		worldId,
		input,
		"crashed-worker",
		300,
	);
	if (!recovered.lease) throw Error("Missing recovery lease");
	f.store.dispatchPublicationModel(
		recovered.lease,
		run.id,
		job.id,
		prepared.request.id,
	);
	f.store.finishPublicationModel(worldId, job.id, prepared.request.id, {
		status: "unknown",
	});
	f.store.releaseLifeLease(recovered.lease, f.clock.now());
	await f.reopen();
	f.model.text = () =>
		JSON.stringify({
			kind: "post",
			segments: [{ kind: "imaginative", text: "A public moment." }],
		});
	f.model.journal.set(prepared.request.id, {
		status: "completed",
		result: f.model.result(prepared),
	});
	expect(await visitLifePublication(f, worldId, signal())).toBeNull();
	expect(f.store.publicationJob(worldId, job.id)).toMatchObject({
		status: "ready",
		postId: null,
	});
	expect(f.status().usage).toMatchObject({
		inputTokens: 11,
		outputTokens: 7,
		unknownRequests: 0,
		reservedInputTokens: 0,
	});
	expect(f.model.requests).toHaveLength(0);
	expect(await visitLifePublication(f, worldId, signal())).toBeNull();
	expect(f.model.reconciled).toEqual([prepared]);
	const completed = await f.runner.publish(worldId, input, signal());
	expect(completed.outcomes).toEqual(["published"]);
	const post = f.store.publicationJob(worldId, job.id).postId;
	expect(post).not.toBeNull();
	await f.reopen();
	expect(await f.runner.publish(worldId, input, signal())).toEqual(completed);
	expect(f.store.publicationJob(worldId, job.id).postId).toBe(post);
	expect(f.model.requests).toHaveLength(0);
	expect(f.clock.pending).toBe(0);
});

test("scheduled recovery cannot reuse a paused operator's saved manual authority for inference and publication", async () => {
	const { f, job, prepared } = await preparedFixture("manual", (f) =>
		restrictScheduledPublication(f, "both"),
	);
	f.model.text = () =>
		JSON.stringify({
			kind: "post",
			segments: [{ kind: "imaginative", text: "A public moment." }],
		});
	await f.reopen();
	expect(await visitLifePublication(f, worldId, signal())).toBeNull();
	expect(f.model.reconciled).toEqual([prepared]);
	expect(f.model.requests).toHaveLength(0);
	expect(f.store.publicationJob(worldId, job.id)).toMatchObject({
		status: "prepared",
		postId: null,
	});
});

test.each(["prepare", "complete", "reconcile"] as const)(
	"scheduled manual recovery rechecks publication authority after awaiting %s",
	async (boundary) => {
		const f =
			boundary === "reconcile" ? (await preparedFixture()).f : fixture();
		if (boundary !== "reconcile") {
			const run = f.store.beginPublicationRun(
				worldId,
				f.input(),
				"crashed-worker",
				300,
			);
			if (!run.lease) throw Error("Missing run lease");
			f.store.releaseLifeLease(run.lease, f.clock.now());
		}
		const entered = deferred<void>(),
			release = deferred<void>();
		if (boundary === "prepare")
			f.model.onPrepare = async () => {
				entered.resolve();
				await release.promise;
			};
		if (boundary === "complete")
			f.model.onComplete = async (prepared) => {
				entered.resolve();
				await release.promise;
				return f.model.result(prepared);
			};
		if (boundary === "reconcile") {
			const reconcile = f.model.reconcile.bind(f.model);
			f.model.reconcile = async (prepared) => {
				entered.resolve();
				await release.promise;
				return reconcile(prepared);
			};
		}
		const running = visitLifePublication(f, worldId, signal());
		await entered.promise;
		restrictScheduledPublication(f, "both");
		release.resolve();
		expect(await running).toBeNull();
		expect(f.model.requests).toHaveLength(boundary === "complete" ? 1 : 0);
		const run = f.store.pendingPublicationRuns(worldId)[0];
		expect(run?.status).toBe("running");
		const item = run?.batch[0];
		if (!item) throw Error("Missing saved batch");
		expect(f.store.publicationJob(worldId, item.jobId)).toMatchObject({
			status: boundary === "complete" ? "ready" : "prepared",
			postId: null,
		});
		if (boundary === "complete") expect(f.status().usage.inputTokens).toBe(11);
		expect(f.clock.pending).toBe(0);
	},
);

test("publish rejects while simulation owns the runner and model", async () => {
	const f = runtimeStoreFixture(false);
	cleanups.push(() => f.close());
	const entered = deferred<void>(),
		release = deferred<void>();
	f.model.onComplete = async (request) => {
		entered.resolve();
		await release.promise;
		return f.model.result(request);
	};
	const running = f.runner.run(worldId, "simulation", 1, signal());
	await entered.promise;
	try {
		await expect(
			f.runner.publish(
				worldId,
				{
					requestKey: "publish",
					expectedConfigRevision: 1,
					expectedSettingsRevision: 0,
					mode: "manual",
				},
				signal(),
			),
		).rejects.toMatchObject({ status: "busy" });
	} finally {
		release.resolve();
	}
	expect((await running).status).toBe("accepted");
});

test("one permitted post commits once and later arrivals never enter a terminal fixed batch", async () => {
	const f = fixture(),
		input = f.input();
	f.model.text = (request) => {
		const parsed = JSON.parse(request.input);
		return JSON.stringify({
			kind: "post",
			segments: [{ kind: "claim", claimId: parsed.material.claims[0].id }],
		});
	};
	const first = await f.runner.publish(worldId, input, signal());
	expect(first.outcomes).toEqual(["published"]);
	const later = queueLaterIntent(f, "later-intent");
	expect(await f.runner.publish(worldId, input, signal())).toEqual(first);
	await f.reopen();
	expect(await f.runner.publish(worldId, input, signal())).toEqual(first);
	expect(f.store.publicationJob(worldId, later.id).status).toBe("pending");
	expect(f.model.requests).toHaveLength(1);
	await expect(
		f.runner.publish(worldId, { ...input, mode: "automatic" }, signal()),
	).rejects.toThrow("request conflict");
});

test("an empty run receipt cannot absorb jobs arriving after restart", async () => {
	const f = fixture();
	await f.runner.publish(worldId, f.input(), signal());
	const input = f.input("empty");
	const empty = await f.runner.publish(worldId, input, signal());
	expect(empty.batch).toEqual([]);
	queueLaterIntent(f, "later-empty");
	await f.reopen();
	expect(await f.runner.publish(worldId, input, signal())).toEqual(empty);
	expect(f.model.requests).toHaveLength(1);
});

test("a saved never-dispatched preparation reconciles and dispatches that exact request once after reopen", async () => {
	const { f, input, prepared } = await preparedFixture();
	await f.reopen();
	const run = await f.runner.publish(worldId, input, signal());
	expect(run.outcomes).toEqual(["skipped"]);
	expect(f.model.prepared).toHaveLength(1);
	expect(f.model.reconciled).toEqual([prepared]);
	expect(f.model.requests).toEqual([prepared.request]);
	expect(f.status().usage.reservedInputTokens).toBe(0);
});

test.each(["dispatched", "unknown"] as const)(
	"%s journal absence retains reservations across reopen and never redispatches",
	async (status) => {
		const { f, input, job, prepared } = await preparedFixture();
		const run = f.store.beginPublicationRun(
			worldId,
			input,
			"crashed-worker",
			300,
		);
		if (!run.lease) throw Error("Missing fixture lease");
		f.store.dispatchPublicationModel(
			run.lease,
			run.id,
			job.id,
			prepared.request.id,
		);
		if (status === "unknown")
			f.store.finishPublicationModel(worldId, job.id, prepared.request.id, {
				status: "unknown",
			});
		f.store.releaseLifeLease(run.lease, f.clock.now());
		await f.reopen();
		f.clock.advance(3000);
		const resumed = await f.runner.publish(worldId, input, signal());
		expect(resumed.status).toBe("running");
		expect(f.store.publicationJob(worldId, job.id).status).toBe("unknown");
		expect(f.status().usage).toMatchObject({
			unknownRequests: 1,
			reservedInputTokens: 100,
			reservedOutputTokens: 100,
		});
		expect(f.model.requests).toHaveLength(0);
		expect(f.clock.pending).toBe(0);
		f.model.journal.set(prepared.request.id, {
			status: "completed",
			result: f.model.result(prepared),
		});
		expect((await f.runner.publish(worldId, input, signal())).outcomes).toEqual(
			["skipped"],
		);
		expect(f.model.requests).toHaveLength(0);
	},
);

test("unknown automatic work reconciles while paused and revoked, retaining ready output without spinning or committing", async () => {
	const { f, input, job, prepared } = await preparedFixture("automatic");
	const run = f.store.beginPublicationRun(
		worldId,
		input,
		"crashed-worker",
		300,
	);
	if (!run.lease) throw Error("Missing fixture lease");
	f.store.dispatchPublicationModel(
		run.lease,
		run.id,
		job.id,
		prepared.request.id,
	);
	f.store.finishPublicationModel(worldId, job.id, prepared.request.id, {
		status: "unknown",
	});
	const { worldId: _w, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		run: { mode: "paused" },
		publication: { mode: "automatic", recipientIds: [] },
	});
	f.options.beforePrepare = () => {
		throw Error("Task source revoked");
	};
	f.model.journal.set(prepared.request.id, {
		status: "completed",
		result: f.model.result(prepared),
	});
	await f.reopen();
	const resumed = await f.runner.publish(worldId, input, signal());
	expect(resumed.status).toBe("running");
	expect(f.store.publicationJob(worldId, job.id).status).toBe("ready");
	expect(f.status().usage.inputTokens).toBe(11);
	expect(f.status().usage.reservedInputTokens).toBe(0);
	expect(f.model.reconciled).toHaveLength(1);
	expect(f.model.requests).toHaveLength(0);
	expect(f.clock.pending).toBe(0);
	await f.runner.publish(worldId, input, signal());
	expect(f.model.reconciled).toHaveLength(1);
});

test.each(["author", "settings", "source"] as const)(
	"%s change during native preparation blocks dispatch and leaves a retryable advanced job",
	async (change) => {
		const f = fixture(),
			entered = deferred<void>(),
			release = deferred<void>();
		let sourceCurrent = true;
		if (!f.options.publication) throw Error("Missing fixture configuration");
		f.options.publication.assertSourceCurrent = () => {
			if (!sourceCurrent) throw Error("Task source changed");
		};
		f.model.onPrepare = async () => {
			entered.resolve();
			await release.promise;
		};
		const running = f.runner.publish(worldId, f.input(), signal());
		await entered.promise;
		if (change === "author") f.changeAuthor();
		if (change === "settings") {
			const identity = f.options.identity(worldId);
			f.options.identity = () => ({ ...identity, modelSettingsRevision: 8 });
		}
		if (change === "source") sourceCurrent = false;
		release.resolve();
		const result = await running;
		expect(result.outcomes).toEqual(["failed"]);
		expect(f.model.requests).toHaveLength(0);
		expect(f.status().usage.reservedInputTokens).toBe(0);
		const job = f.store.publicationJob(worldId, result.batch[0]?.jobId ?? "");
		expect(() =>
			f.store.retryPublicationJob(worldId, job.id, {
				requestKey: "retry",
				expectedRevision: job.revision,
			}),
		).not.toThrow();
	},
);

test("profile changes after dispatch retain usage and cannot publish the completed result", async () => {
	const f = fixture();
	f.model.onComplete = async (request) => {
		f.changeAuthor();
		return f.model.result(request);
	};
	const run = await f.runner.publish(worldId, f.input(), signal());
	expect(run.outcomes).toEqual(["failed"]);
	expect(f.status().usage).toMatchObject({
		inputTokens: 11,
		outputTokens: 7,
		reservedInputTokens: 0,
	});
	expect(f.clock.pending).toBe(0);
});

test("foreground cancellation holds unknown usage and close drains the shared model and lease", async () => {
	const f = fixture(),
		entered = deferred<void>(),
		aborted = deferred<void>(),
		release = deferred<void>();
	f.model.onComplete = async (_request, signal) => {
		entered.resolve();
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		await release.promise;
		throw signal.reason;
	};
	const running = f.runner.publish(worldId, f.input(), signal());
	await entered.promise;
	f.foreground.set(true);
	await aborted.promise;
	const closing = f.runner.close();
	expect(f.model.closed).toBe(false);
	await expect(
		f.runner.publish(worldId, f.input(), signal()),
	).rejects.toMatchObject({ status: "closed" });
	release.resolve();
	expect((await running).status).toBe("running");
	await closing;
	expect(f.status().usage.unknownRequests).toBe(1);
	expect(f.status().schedule?.lease).toBeNull();
	expect(f.model.closed).toBe(true);
	expect(f.clock.pending).toBe(0);
});

test("partial batch failure advances every terminal attempt so an explicit retry is not stranded", async () => {
	const f = fixture();
	const { worldId: _w, revision, ...config } = f.store.lifeConfig(worldId);
	if (!config.limits) throw Error("Missing fixture limits");
	f.store.setLifeConfig(worldId, revision, {
		...config,
		limits: { ...config.limits, maxModelCalls: 2 },
	});
	const settings = f.store.publicationSettings(worldId);
	if (!settings) throw Error("Missing fixture settings");
	const { worldId: _sw, revision: sr, ...input } = settings;
	f.store.setPublicationSettings(worldId, sr, { ...input, maxJobsPerRun: 2 });
	// A queued source that no longer has current material must not strand another attempt.
	queueLaterIntent(f, "expired-intent");
	f.model.text = () => "{invalid";
	const run = await f.runner.publish(worldId, f.input(), signal());
	expect(run.outcomes).toEqual(["failed", "failed"]);
	expect(run.nextIndex).toBe(2);
	const jobs = run.batch.map((item) =>
		f.store.publicationJob(worldId, item.jobId),
	);
	const first = jobs.find(
		(job) => job.version === 1 && job.intentId === "intent",
	);
	if (!first) throw Error("Missing successful source fixture");
	f.store.retryPublicationJob(worldId, first.id, {
		requestKey: "retry",
		expectedRevision: first.revision,
	});
	f.model.text = () => '{"kind":"no_post"}';
	expect(
		(await f.runner.publish(worldId, f.input("retry-run"), signal())).outcomes,
	).toEqual(["skipped"]);
	expect(f.model.requests).toHaveLength(2);
	await f.reopen();
});

test("publication heartbeat renews the same world lease and a deadline awaits native cancellation", async () => {
	const f = fixture(),
		entered = deferred<void>();
	f.model.onComplete = async (_request, signal) => {
		entered.resolve();
		await new Promise<void>((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			}),
		);
		throw Error("unreachable");
	};
	const running = f.runner.publish(worldId, f.input(), signal());
	await entered.promise;
	await f.clock.waitingAt(1100);
	f.clock.advance(1100);
	await f.clock.waitingAt(1200);
	expect(f.status().schedule?.lease?.expiresAt).toBe(1400);
	const deadline = 1000 + (f.model.requests[0]?.limits.timeoutMs ?? 0);
	f.clock.advance(deadline);
	expect((await running).status).toBe("running");
	expect(f.status().usage.unknownRequests).toBe(1);
	expect(f.clock.pending).toBe(0);
});

test("the final guard after core reservation cancels a prepared receipt when the author changes", async () => {
	const f = fixture();
	const prepare = f.store.preparePublicationModel.bind(f.store);
	f.store.preparePublicationModel = (...args) => {
		const record = prepare(...args);
		f.changeAuthor();
		return record;
	};
	const run = await f.runner.publish(worldId, f.input(), signal());
	expect(run.outcomes).toEqual(["failed"]);
	expect(f.receipts.list(worldId)[0]).toMatchObject({
		status: "failed",
		upstreamAttempts: 0,
	});
	expect(f.model.requests).toHaveLength(0);
	expect(f.status().usage.reservedInputTokens).toBe(0);
});

test("lease takeover preserves finished usage and never attempts to release another owner's lease", async () => {
	const f = fixture(),
		input = f.input();
	let releases = 0;
	const release = f.store.releaseLifeLease.bind(f.store);
	f.options.store = new Proxy(f.store, {
		get(target, key, receiver) {
			if (key === "releaseLifeLease")
				return (...args: Parameters<WorldStore["releaseLifeLease"]>) => {
					releases++;
					release(...args);
				};
			return Reflect.get(target, key, receiver);
		},
	});
	f.model.onComplete = async (request) => {
		f.clock.time += 400;
		f.store.beginPublicationRun(worldId, input, "other-owner", 300);
		return f.model.result(request);
	};
	await expect(f.runner.publish(worldId, input, signal())).rejects.toThrow(
		"current lease",
	);
	expect(f.status().usage.inputTokens).toBe(11);
	expect(f.status().schedule?.lease?.owner).toBe("other-owner");
	expect(releases).toBe(0);
	expect(f.clock.pending).toBe(0);
});

test("prepared journal uncertainty holds the reservation without a new prepare or dispatch", async () => {
	const { f, input, prepared, job } = await preparedFixture();
	f.model.journal.set(prepared.request.id, { status: "unknown" });
	const run = await f.runner.publish(worldId, input, signal());
	expect(run.status).toBe("running");
	expect(f.store.publicationJob(worldId, job.id).status).toBe("prepared");
	expect(f.model.prepared).toHaveLength(1);
	expect(f.model.requests).toHaveLength(0);
	expect(f.status().usage.reservedInputTokens).toBe(100);
});

test("a returned result stays accounted after cancellation even when the later journal read is unavailable", async () => {
	const f = fixture();
	f.model.complete = async (request) => {
		f.runner.cancel(worldId);
		return f.model.result(request);
	};
	f.model.reconcile = async () => {
		throw Error("Native journal temporarily unavailable");
	};
	const run = await f.runner.publish(worldId, f.input(), signal());
	expect(f.status().usage).toMatchObject({
		inputTokens: 11,
		outputTokens: 7,
		reservedInputTokens: 0,
		unknownRequests: 0,
	});
	expect(run.outcomes).toEqual(["failed"]);
	expect(f.clock.pending).toBe(0);
});

test("simulation uncertainty prevents a publication call using the same world's accounting", async () => {
	const f = runtimeStoreFixture(false, (pack) => {
		for (const event of pack.autonomy.events) event.cooldownSteps = 0;
		pack.life.projection.disclosures.push({
			subject: { kind: "world_event", id: "test-world:1" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "friends" }],
				publication: ["friends"],
			},
		});
	});
	cleanups.push(() => f.close());
	const { worldId: _w, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		publication: { mode: "automatic", recipientIds: ["friends"] },
	});
	f.store.setPublicationSettings(worldId, 0, {
		version: 1,
		agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
		reactionIds: [],
		maxChainDepth: 3,
		maxActionsPerChain: 20,
		perAuthorCooldownSteps: 0,
		maxJobsPerRun: 1,
	});
	const runner = createLifeRunner({
		...f.options,
		publication: { store: f.store, author: () => publicationAuthor },
	});
	cleanups.push(() => runner.close());
	expect(
		(await runner.run(worldId, "accepted-source", 2, signal())).status,
	).toBe("accepted");
	f.model.onComplete = async () => {
		throw Error("Native outcome unknown");
	};
	const uncertain = await runner.run(
		worldId,
		"unknown-simulation",
		2,
		signal(),
	);
	expect(uncertain.status).toBe("needs_attention");
	const calls = f.model.requests.length,
		prepared = f.model.prepared.length;
	const run = await runner.publish(
		worldId,
		{
			requestKey: "blocked-usage",
			expectedConfigRevision: 2,
			expectedSettingsRevision: 1,
			mode: "manual",
		},
		signal(),
	);
	expect(run.outcomes).toEqual(["failed"]);
	expect(f.store.publicationJob(worldId, run.batch[0]?.jobId ?? "").error).toBe(
		"budget",
	);
	expect(f.model.requests).toHaveLength(calls);
	expect(f.model.prepared).toHaveLength(prepared);
	expect(f.store.lifeStatus(worldId, f.clock.now()).usage.unknownRequests).toBe(
		1,
	);
});
