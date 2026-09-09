import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentError } from "../../lina-core/src/attachments/types.ts";
import {
	inspectContent,
	metadataShape,
} from "../../lina-core/src/attachments/validation.ts";
import type {
	ImageArtifactPort,
	ImageCompletion,
	LifeImageInput,
} from "../src/images/contracts.ts";
import { type ImageClient, ImageJobs } from "../src/images/jobs.ts";
import { ImageJobStore } from "../src/images/store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
	"base64",
);
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const owner = { kind: "life" as const, worldId: "world-a", agentId: "agent-a" };
const limits = {
	maxActiveJobs: 8,
	maxArchivedJobs: 32,
	maxActiveBytes: 1_000_000,
	maxArchiveBytes: 2_000_000,
	maxTotalBytes: 3_000_000,
};
const input: LifeImageInput = {
	origin: {
		kind: "life",
		intentId: "real-intent",
		attemptId: "real-attempt",
		briefDigest: "a".repeat(64),
	},
	provider: "fixture",
	model: "image-one",
	prompt: "Approved identity",
	reference: null,
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-life-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "assets"));
	const store = new ImageJobStore(root, owner, limits);
	let posts = 0;
	let downloads = 0;
	let failImport = false;
	let completion: ImageCompletion = { kind: "pending" };
	let receiptCalls = 0;
	const reads: string[] = [];
	const verified: string[] = [];
	const artifacts: ImageArtifactPort = {
		resolveReference: () => ({ bytes: new Uint8Array(png), mime: "image/png" }),
		preflight: () => {},
		importOutput: (job, output) => {
			const name = `image-${job.id}.png`;
			inspectContent(name, output.bytes);
			const path = join(root, "assets", job.id);
			let existing: Buffer | undefined;
			try {
				existing = readFileSync(path);
			} catch (error) {
				if (
					!(
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "ENOENT"
					)
				)
					throw error;
			}
			if (existing && sha(existing) !== sha(output.bytes))
				throw Error("Artifact byte conflict");
			if (!existing) writeFileSync(path, output.bytes);
			if (failImport)
				throw new AttachmentError("quota", "lost metadata receipt");
			const metadata = {
				id: job.id,
				name,
				mime: output.mime,
				size: output.bytes.length,
				sha256: sha(output.bytes),
			};
			writeFileSync(`${path}.json`, JSON.stringify(metadata));
			return metadata;
		},
		verify: (job) => {
			if (!job.artifact) throw Error("Missing imported artifact");
			const meta = metadataShape(
				JSON.parse(
					readFileSync(join(root, "assets", `${job.id}.json`), "utf8"),
				),
			);
			const bytes = readFileSync(join(root, "assets", job.id));
			if (
				sha(bytes) !== job.artifact.sha256 ||
				meta.sha256 !== job.artifact.sha256
			)
				throw Error("Artifact byte conflict");
			verified.push(job.id);
		},
	};
	const client: ImageClient = {
		connect: async () => ({
			baseUrl: "http://127.0.0.1:45678",
			version: "3.14.0",
			ready: true,
			lanes: [],
		}),
		submit: async (request, _signal, beforeSubmit) => {
			// The real client worker owns the final HTTP hook and immutable snapshot tests.
			const body = {
				requestId: request.requestId,
				provider: request.provider,
				model: request.model,
				prompt: request.prompt,
				async: true as const,
				n: 1 as const,
				references: request.reference
					? [
							`data:${request.reference.mime};base64,${Buffer.from(request.reference.bytes).toString("base64")}`,
						]
					: [],
				format: "png" as const,
			};
			const bodyJson = JSON.stringify(body);
			beforeSubmit?.({
				url: "http://127.0.0.1:45678/api/generate",
				method: "POST",
				version: "3.14.0",
				headers: { "Idempotency-Key": request.requestId },
				body,
				bodyJson,
				bodySha256: sha(Buffer.from(bodyJson)),
				bodyByteLength: Buffer.byteLength(bodyJson),
				...(request.reference
					? {
							reference: {
								mime: request.reference.mime,
								byteLength: request.reference.bytes.length,
								sha256: sha(request.reference.bytes),
								dataUrl: body.references[0] ?? "",
							},
						}
					: {}),
			});
			posts++;
			return { requestId: request.requestId, state: "queued" };
		},
		read: async (id) => {
			reads.push(id);
			return {
				requestId: id,
				state: "completed",
				result: { requestId: id, filename: "result.png" },
			};
		},
		download: async () => {
			downloads++;
			return { bytes: new Uint8Array(png), mime: "image/png" };
		},
		cancel: async (id) => ({ requestId: id, active: true, aborted: true }),
	};
	const options = {
		store,
		client,
		artifacts,
		completion: {
			complete: () => {
				receiptCalls++;
				return completion;
			},
		},
	};
	const jobs = new ImageJobs(options);
	cleanup.push(() => jobs.close());
	return {
		root,
		store,
		jobs,
		client,
		artifacts,
		options,
		reads,
		verified,
		posts: () => posts,
		downloads: () => downloads,
		receipts: () => receiptCalls,
		setImportFailure: (value: boolean) => {
			failImport = value;
		},
		setCompletion: (value: ImageCompletion) => {
			completion = value;
		},
	};
}
test("LIFE prepare persists real identity before linking and only explicit guarded start posts the same UUID", async () => {
	const f = fixture();
	const prepared = await f.jobs.prepare(input);
	expect(f.posts()).toBe(0);
	expect(prepared.state).toBe("prepared");
	expect(prepared.requestId).toBeNull();
	expect(
		new ImageJobStore(f.root, owner, limits).get(prepared.id).origin,
	).toEqual(input.origin);
	expect(() => f.jobs.resume()).toThrow("LIFE");
	await f.jobs.recover();
	expect(f.jobs.get(prepared.id).state).toBe("prepared");
	expect(f.posts()).toBe(0);
	await expect(f.jobs.start(input)).rejects.toThrow("prepare");
	let linked: string | null = null;
	const authority = {
		beforeSubmit: (job: { id: string }): undefined => {
			if (linked !== job.id) throw Error("Not linked");
		},
	};
	expect((await f.jobs.startPrepared(prepared.id, authority)).state).toBe(
		"prepared",
	);
	expect(f.posts()).toBe(0);
	linked = prepared.id;
	expect((await f.jobs.startPrepared(prepared.id, authority)).state).toBe(
		"queued",
	);
	await f.jobs.startPrepared(prepared.id, authority);
	expect(f.posts()).toBe(1);
});
test("LIFE frozen reference mismatch and revoked final authority make zero POST and preserve preparation", async () => {
	const f = fixture();
	const reference = {
		owner: { kind: "agent" as const, agentId: "agent-a" },
		referenceId: "approved-reference",
		assetId: randomUUID(),
		sha256: "c".repeat(64),
		mime: "image/png" as const,
		size: png.length,
	};
	const prepared = await f.jobs.prepare({ ...input, reference });
	await f.jobs.startPrepared(prepared.id, { beforeSubmit: () => {} });
	expect(f.posts()).toBe(0);
	expect(f.jobs.get(prepared.id).state).toBe("prepared");
	expect(() =>
		f.store.create({ ...input, reference: { ...reference, sha256: sha(png) } }),
	).toThrow("conflict");
});
test("LIFE failed known output adopts retained UUID bytes after reopen without another POST and keeps prior receipt", async () => {
	const f = fixture();
	f.setImportFailure(true);
	f.setCompletion({ kind: "life", receiptId: "failed-receipt" });
	const job = await f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	expect(f.jobs.get(job.id)).toMatchObject({
		state: "failed",
		resultFilename: "result.png",
		artifact: null,
		delivery: { kind: "life", receiptId: "failed-receipt" },
	});
	expect(readFileSync(join(f.root, "assets", job.id))).toEqual(png);
	await f.jobs.close();
	f.setImportFailure(false);
	f.setCompletion({ kind: "life", receiptId: "recovered-receipt" });
	const next = new ImageJobs({
		...f.options,
		store: new ImageJobStore(f.root, owner, limits),
	});
	cleanup.push(() => next.close());
	const recovered = await next.recoverArtifact(job.id);
	expect(recovered).toMatchObject({
		id: job.id,
		state: "completed",
		artifact: { id: job.id, sha256: sha(png) },
		artifactRecovery: {
			delivery: { kind: "life", receiptId: "failed-receipt" },
		},
		delivery: { kind: "life", receiptId: "recovered-receipt" },
	});
	expect(f.posts()).toBe(1);
	expect(f.downloads()).toBe(2);
	expect(f.verified).toContain(job.id);
	expect(new ImageJobStore(f.root, owner, limits).get(job.id)).toEqual(
		recovered,
	);
	await next.recoverArtifact(job.id);
	expect(f.downloads()).toBe(2);
});
test("LIFE unknown/expired history and endpoint change never resubmit and recovery cannot invent a result", async () => {
	const f = fixture();
	const job = await f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	f.client.read = async (id) => ({ requestId: id, state: "unknown" });
	expect((await f.jobs.reconcile(job.id)).state).toBe("uncertain");
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	expect(f.posts()).toBe(1);
	f.client.connect = async () => ({
		baseUrl: "http://127.0.0.1:49999",
		version: "3.14.0",
		ready: true,
		lanes: [],
	});
	f.client.read = async () => {
		throw Error("must not read changed endpoint");
	};
	expect((await f.jobs.reconcile(job.id)).state).toBe("uncertain");
	expect(f.posts()).toBe(1);
	await expect(f.jobs.recoverArtifact(job.id)).rejects.toThrow("recovery");
});
test("LIFE completion pending/foreign receipt and lost artifact never become delivered", async () => {
	const f = fixture();
	const job = await f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	expect(f.jobs.get(job.id).delivery).toEqual({ kind: "pending" });
	f.setCompletion({ kind: "conversation", entryId: "foreign" });
	await f.jobs.flushNotices();
	expect(f.jobs.get(job.id).delivery).toEqual({ kind: "pending" });
	f.setCompletion({ kind: "life", receiptId: "real" });
	rmSync(join(f.root, "assets", job.id));
	const calls = f.receipts();
	await f.jobs.flushNotices();
	expect(f.receipts()).toBe(calls);
	expect(f.jobs.get(job.id).delivery).toEqual({ kind: "pending" });
});
test("LIFE failed output recovery rejects conflicting orphan bytes and keeps original terminal", async () => {
	const f = fixture();
	f.setImportFailure(true);
	const job = await f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	writeFileSync(join(f.root, "assets", job.id), "conflicting");
	f.setImportFailure(false);
	await expect(f.jobs.recoverArtifact(job.id)).rejects.toThrow("conflict");
	expect(f.jobs.get(job.id).state).toBe("failed");
	expect(f.posts()).toBe(1);
});

test("LIFE final hook rejects a changed provider payload before the POST", async () => {
	const f = fixture();
	const submit = f.client.submit;
	f.client.submit = (request, signal, hook) =>
		submit({ ...request, prompt: "Changed after preparation" }, signal, hook);
	const job = f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	expect(f.posts()).toBe(0);
	expect(f.jobs.get(job.id).state).toBe("prepared");
});

test("LIFE outcome notifications do not wake the scheduler again for unchanged unknown reads", async () => {
	const f = fixture();
	const changes: string[] = [];
	const jobs = new ImageJobs({
		...f.options,
		onChange: (job) => changes.push(job.state),
	});
	cleanup.push(() => jobs.close());
	const job = jobs.prepare(input);
	await jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	f.client.read = async (id) => ({ requestId: id, state: "unknown" });
	await jobs.reconcile(job.id);
	const count = changes.length;
	await jobs.reconcile(job.id);
	expect(changes.length).toBe(count);
});

test("LIFE artifact recovery refuses changed original endpoint and result filename", async () => {
	const f = fixture();
	f.setImportFailure(true);
	const job = f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	expect(() =>
		f.store.update(job.id, { resultFilename: "another.png" }),
	).toThrow("terminal");
	f.client.connect = async () => ({
		baseUrl: "http://127.0.0.1:49999",
		version: "3.14.0",
		ready: true,
		lanes: [],
	});
	await expect(f.jobs.recoverArtifact(job.id)).rejects.toThrow(
		"runtime changed",
	);
	expect(f.downloads()).toBe(1);
	expect(f.posts()).toBe(1);
});

test("LIFE prepare rejection and late abort retain one durable UUID with zero POST", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.artifacts.preflight = async () => {
		entered.resolve();
		await release.promise;
	};
	const job = f.jobs.prepare(input);
	const abort = new AbortController();
	const work = f.jobs.startPrepared(
		job.id,
		{ beforeSubmit: () => {} },
		abort.signal,
	);
	await entered.promise;
	abort.abort();
	release.resolve();
	expect((await work).state).toBe("prepared");
	expect(f.posts()).toBe(0);
	expect(new ImageJobStore(f.root, owner, limits).get(job.id).id).toBe(job.id);
});

test("acknowledged completed LIFE bytes are verified again during explicit reconciliation", async () => {
	const f = fixture();
	f.setCompletion({ kind: "life", receiptId: "receipt" });
	const job = f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	rmSync(join(f.root, "assets", job.id));
	await expect(f.jobs.reconcile(job.id)).rejects.toThrow();
	expect(f.posts()).toBe(1);
});

test("LIFE prepare/link/start reaches the real client's final hook with the exact same frozen reference bytes", async () => {
	const { fixture: transport } = await import("./ima2-client-fixture.ts");
	const f = fixture();
	let upstreamId = "";
	const wire = transport(async (request) => {
		const body = (await request.json()) as { requestId: string };
		upstreamId = body.requestId;
		return Response.json(
			{ requestId: body.requestId, async: true },
			{ status: 202 },
		);
	});
	const jobs = new ImageJobs({ ...f.options, client: wire.client });
	cleanup.push(() => jobs.close());
	const reference = {
		owner: { kind: "agent" as const, agentId: "agent-a" },
		referenceId: "ref",
		assetId: randomUUID(),
		sha256: sha(png),
		mime: "image/png" as const,
		size: png.length,
	};
	const job = jobs.prepare({
		...input,
		provider: "api",
		model: "image-model",
		reference,
	});
	let checked = false;
	const result = await jobs.startPrepared(job.id, {
		beforeSubmit: (prepared, snapshot) => {
			checked = true;
			expect(prepared.id).toBe(job.id);
			expect(snapshot.body.requestId).toBe(job.id);
			expect(snapshot.reference?.sha256).toBe(sha(png));
			expect(snapshot.reference?.dataUrl).toBe(
				`data:image/png;base64,${png.toString("base64")}`,
			);
		},
	});
	expect(checked).toBe(true);
	expect(result.state).toBe("queued");
	expect(upstreamId).toBe(job.id);
	expect(
		wire.requests.filter((request) => request.method === "POST"),
	).toHaveLength(1);
});

test("repair1 held failure completion cannot acknowledge recovered success", async () => {
	const f = fixture();
	f.setImportFailure(true);
	const job = f.jobs.prepare(input);
	await f.jobs.startPrepared(job.id, { beforeSubmit: () => {} });
	await f.jobs.reconcile(job.id);
	expect(f.jobs.get(job.id).state).toBe("failed");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const recovered = Promise.withResolvers<void>();
	const calls: string[] = [];
	const jobs = new ImageJobs({
		...f.options,
		onChange: (current) => {
			if (current.state === "completed") recovered.resolve();
		},
		completion: {
			complete: async (observed) => {
				calls.push(observed.state);
				if (observed.state === "failed") {
					entered.resolve();
					await release.promise;
					return { kind: "life", receiptId: "receipt-failed" };
				}
				return { kind: "life", receiptId: "receipt-recovered" };
			},
		},
	});
	cleanup.push(() => jobs.close());
	const flush = jobs.flushNotices();
	await entered.promise;
	f.setImportFailure(false);
	const recovery = jobs.recoverArtifact(job.id);
	try {
		await recovered.promise;
		expect(
			ImageJobStore.openExisting(f.root, owner, limits).get(job.id).state,
		).toBe("completed");
	} finally {
		release.resolve();
	}
	await Promise.all([flush, recovery]);
	const current = ImageJobStore.openExisting(f.root, owner, limits).get(job.id);
	expect(current.delivery).toEqual({
		kind: "life",
		receiptId: "receipt-recovered",
	});
	expect(current.artifactRecovery?.delivery).toEqual({
		kind: "life",
		receiptId: "receipt-failed",
	});
	expect(calls).toEqual(["failed", "completed"]);
	expect(f.posts()).toBe(1);
	await jobs.flushNotices();
	expect(calls).toEqual(["failed", "completed"]);
});

test("repair1 prepared cancellation emits committed change and completes without a LIFE resume", async () => {
	const f = fixture();
	const changes: string[] = [];
	const completions: string[] = [];
	const jobs = new ImageJobs({
		...f.options,
		onChange: (job) => changes.push(job.state),
		completion: {
			complete: (job) => {
				completions.push(job.state);
				return { kind: "life", receiptId: "cancelled-receipt" };
			},
		},
	});
	cleanup.push(() => jobs.close());
	const job = jobs.prepare(input);
	expect(changes).toEqual(["prepared"]);
	changes.length = 0;
	const cancelled = await jobs.cancel(job.id);
	expect(changes).toContain("cancelled");
	expect(completions).toEqual(["cancelled"]);
	expect(cancelled.delivery).toEqual({
		kind: "life",
		receiptId: "cancelled-receipt",
	});
	expect(f.posts()).toBe(0);
	expect(ImageJobStore.openExisting(f.root, owner, limits).get(job.id)).toEqual(
		cancelled,
	);
	const count = changes.length;
	await jobs.cancel(job.id);
	expect(changes).toHaveLength(count);
	expect(completions).toHaveLength(1);
});
