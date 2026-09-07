import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import { Ima2Error } from "../src/images/client-types.ts";
import { ImageJobs } from "../src/images/jobs.ts";
import { ImageJobStore } from "../src/images/store.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
	"base64",
);
const request = {
	requestId: "chat-1",
	callId: "call-1",
	provider: "fixture",
	model: "image-one",
	prompt: "A blue circle",
	sourceArtifactId: null,
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-jobs-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "a80be8ed-a493-4e88-8523-b5f85d73d652",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	const attached = new AttachmentStore(root, binding);
	cleanups.push(() => attached.close());
	const store = new ImageJobStore(root, binding);
	return { root, binding, attached, store };
}
// The transport fixtures will use the pinned adapter's exported contract.
test("generation completion imports once, delivers once after restart, and edits owned bytes", async () => {
	const f = fixture();
	const submitted: unknown[] = [];
	const notices = new Map<string, string>();
	const client = {
		connect: async () => ({
			baseUrl: "http://127.0.0.1:45678",
			version: "3.14.0",
			ready: true,
			lanes: [],
		}),
		submit: async (input: { requestId: string }) => {
			submitted.push(input);
			return { state: "queued" as const, requestId: input.requestId };
		},
		read: async (id: string) => ({
			state: "completed" as const,
			requestId: id,
			result: { requestId: id, filename: "result.png" },
		}),
		cancel: async () => ({ requestId: "fixture", active: true, aborted: true }),
		download: async () => ({ bytes: png, mime: "image/png" as const }),
	};
	const notify = async (marker: { jobId: string }, text: string) => {
		notices.set(marker.jobId, text);
		return marker.jobId;
	};
	const jobs = new ImageJobs({
		store: f.store,
		attachments: f.attached,
		client,
		notify,
	});
	const first = await jobs.start(request);
	await jobs.reconcile(first.id);
	expect(f.store.get(first.id)).toMatchObject({
		state: "completed",
		artifact: { id: first.id, mime: "image/png" },
	});
	expect(notices.size).toBe(1);
	expect([...notices.values()][0]).toStartWith("이미지를 만들었습니다.\n\n");
	expect([...notices.values()][0]).toContain(
		`/api/attachments/${first.id}/preview?sessionId=${f.binding.sessionId}`,
	);
	const restored = new ImageJobs({
		store: new ImageJobStore(f.root, f.binding),
		attachments: f.attached,
		client,
		notify,
	});
	await restored.recover();
	expect(submitted).toHaveLength(1);
	expect(notices.size).toBe(1);
	await restored.start({
		...request,
		requestId: "chat-2",
		callId: "call-2",
		prompt: "Make it green",
		sourceArtifactId: first.id,
	});
	expect(submitted).toHaveLength(2);
	expect(submitted[1]).toMatchObject({
		reference: { bytes: new Uint8Array(png), mime: "image/png" },
	});
	await jobs.close();
	await restored.close();
});

function backend(
	overrides: Partial<import("../src/images/jobs.ts").ImageClient> = {},
) {
	const submits: Array<{ requestId: string }> = [];
	const client: import("../src/images/jobs.ts").ImageClient = {
		connect: async () => ({
			baseUrl: "http://127.0.0.1:45678",
			version: "3.14.0",
			ready: true,
			lanes: [],
			ownership: "external",
			setupUrl: "http://127.0.0.1:45678",
		}),
		submit: async (input) => {
			submits.push(input);
			return { requestId: input.requestId, state: "queued" };
		},
		read: async (id) => ({ requestId: id, state: "unknown" }),
		cancel: async (id) => ({ requestId: id, active: true, aborted: true }),
		download: async () => ({ bytes: new Uint8Array(png), mime: "image/png" }),
		...overrides,
	};
	return { client, submits };
}
function manager(
	f: ReturnType<typeof fixture>,
	client: import("../src/images/jobs.ts").ImageClient,
) {
	const jobs = new ImageJobs({
		store: f.store,
		attachments: f.attached,
		client,
		notify: async () => null,
	});
	cleanups.push(() => jobs.close());
	return jobs;
}

test("lost submit response is reconciled on restart without another POST", async () => {
	const f = fixture();
	let posts = 0;
	const first = backend({
		submit: async () => {
			posts++;
			throw Error("lost response secret-token");
		},
	});
	const jobs = manager(f, first.client);
	const pending = await jobs.start(request);
	expect(pending.state).toBe("uncertain");
	expect(pending.error).not.toContain("secret-token");
	await jobs.close();
	const recovered = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "result.png" },
		}),
	});
	const next = new ImageJobs({
		store: new ImageJobStore(f.root, f.binding),
		attachments: f.attached,
		client: recovered.client,
		notify: async () => null,
	});
	cleanups.push(() => next.close());
	await next.recover();
	expect(next.get(pending.id).state).toBe("completed");
	expect(posts).toBe(1);
	expect(recovered.submits).toHaveLength(0);
});

test("cancel acknowledgement stays cancelling until upstream confirms a terminal outcome", async () => {
	const f = fixture();
	let terminal = false;
	let cancellations = 0;
	const { client } = backend({
		cancel: async (id) => {
			cancellations++;
			return { requestId: id, active: true, aborted: true };
		},
		read: async (id) => ({
			requestId: id,
			state: terminal ? "cancelled" : "running",
		}),
	});
	const jobs = manager(f, client);
	const job = await jobs.start(request);
	expect((await jobs.cancel(job.id)).state).toBe("cancelling");
	const saved = new ImageJobStore(f.root, f.binding);
	expect(saved.get(job.id).state).toBe("cancelling");
	terminal = true;
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id).state).toBe("cancelled");
	expect(cancellations).toBe(1);
});

test("a completion racing cancellation is retained and shown as completed", async () => {
	const f = fixture();
	const { client } = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "result.png" },
		}),
	});
	const jobs = manager(f, client);
	const job = await jobs.start(request);
	expect((await jobs.cancel(job.id)).state).toBe("completed");
	expect(f.attached.bytes(job.id)).toEqual(new Uint8Array(png));
});

test("foreign reference is rejected before generation and creates no image job", async () => {
	const f = fixture();
	const other = fixture();
	const source = other.attached.put("other.png", png);
	const { client, submits } = backend();
	const jobs = manager(f, client);
	await expect(
		jobs.start({ ...request, sourceArtifactId: source.id }),
	).rejects.toThrow("not found");
	expect(jobs.list()).toEqual([]);
	expect(submits).toEqual([]);
});

test("a changed endpoint cannot receive reads or cancellation of an existing request", async () => {
	const f = fixture();
	const b = backend();
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	let reads = 0;
	let cancels = 0;
	b.client.connect = async () => ({
		baseUrl: "http://127.0.0.1:49999",
		version: "3.14.0",
		ready: true,
		lanes: [],
		ownership: "external",
		setupUrl: "http://127.0.0.1:49999",
	});
	b.client.read = async (id) => {
		reads++;
		return { requestId: id, state: "unknown" };
	};
	b.client.cancel = async (id) => {
		cancels++;
		return { requestId: id, active: false, aborted: false };
	};
	expect((await jobs.reconcile(job.id)).state).toBe("uncertain");
	expect((await jobs.cancel(job.id)).state).toBe("cancelling");
	expect(reads).toBe(0);
	expect(cancels).toBe(0);
});

test("corrupt downloaded bytes produce an import failure without being displayed", async () => {
	const f = fixture();
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "image.png" },
		}),
		download: async () => ({
			bytes: new TextEncoder().encode("not an image"),
			mime: "image/png",
		}),
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id).state).toBe("failed");
	expect(jobs.get(job.id).artifact).toBeNull();
	expect(() => f.attached.get(job.id)).toThrow("not found");
});

test("a busy conversation defers durable completion delivery until idle", async () => {
	const f = fixture();
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "image.png" },
		}),
	});
	let idle = false;
	let sends = 0;
	const jobs = new ImageJobs({
		store: f.store,
		attachments: f.attached,
		client: b.client,
		notify: async () => {
			if (!idle) return null;
			sends++;
			return "native-notice";
		},
	});
	cleanups.push(() => jobs.close());
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	expect(sends).toBe(0);
	expect(jobs.get(job.id).deliveredEntryId).toBeNull();
	idle = true;
	await jobs.flushNotices();
	await jobs.recover();
	expect(sends).toBe(1);
	expect(jobs.get(job.id).deliveredEntryId).toBe("native-notice");
});

test("definite provider/model admission rejection is failed without leaving an uncertain job", async () => {
	const f = fixture();
	const b = backend({
		submit: async () => {
			throw new Ima2Error("MODEL_UNAVAILABLE", "no model", "rejected");
		},
	});
	const jobs = manager(f, b.client);
	const result = await jobs.start(request);
	expect(result.state).toBe("failed");
	expect(result.error).toContain("MODEL_UNAVAILABLE");
});

test("foreign completion identity cannot be imported into an owned job", async () => {
	const f = fixture();
	const b = backend({
		read: async () => ({
			requestId: "foreign",
			state: "completed",
			result: { requestId: "foreign", filename: "image.png" },
		}),
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id).state).toBe("uncertain");
	expect(jobs.get(job.id).artifact).toBeNull();
});

test("restart preserves cancellation intent after a lost cancel response", async () => {
	const f = fixture();
	let attempts = 0;
	let cancelled = false;
	const b = backend({
		cancel: async (id) => {
			attempts++;
			if (attempts === 1) throw Error("connection lost");
			cancelled = true;
			return { requestId: id, active: true, aborted: true };
		},
		read: async (id) => ({
			requestId: id,
			state: cancelled ? "cancelled" : "running",
		}),
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	await jobs.cancel(job.id);
	await jobs.close();
	const next = new ImageJobs({
		store: new ImageJobStore(f.root, f.binding),
		attachments: f.attached,
		client: b.client,
		notify: async () => null,
	});
	cleanups.push(() => next.close());
	await next.recover();
	expect(next.get(job.id).state).toBe("cancelled");
	expect(attempts).toBe(2);
});

test("a concurrent read cannot consume a cancellation request", async () => {
	const f = fixture();
	let cancels = 0;
	const b = backend({
		read: async (id) => ({ requestId: id, state: "running" }),
		cancel: async (id) => {
			cancels++;
			return { requestId: id, active: true, aborted: true };
		},
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	const cancellation = jobs.cancel(job.id);
	const competing = jobs.reconcile(job.id);
	await Promise.all([cancellation, competing]);
	expect(cancels).toBeGreaterThan(0);
	expect(jobs.get(job.id).state).toBe("cancelling");
});

test("queued and post-processing phases remain visible in the persisted job", async () => {
	const f = fixture();
	const b = backend({
		read: async (id) => ({ requestId: id, state: "post_processing" }),
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	expect(job.state).toBe("queued");
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id).state).toBe("post_processing");
});

test("synchronous notice events do not enter completion delivery twice", async () => {
	const f = fixture();
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "image.png" },
		}),
	});
	let deliveries = 0;
	let nested: Promise<void> | undefined;
	const jobs = new ImageJobs({
		store: f.store,
		attachments: f.attached,
		client: b.client,
		notify: async () => {
			deliveries++;
			if (deliveries === 1) nested = jobs.flushNotices();
			return "saved-notice";
		},
	});
	cleanups.push(() => jobs.close());
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	await nested;
	expect(deliveries).toBe(1);
});

test("an undeliverable notice remains recoverable and never poisons shutdown", async () => {
	const f = fixture();
	let fail = true;
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "image.png" },
		}),
	});
	const jobs = new ImageJobs({
		store: f.store,
		attachments: f.attached,
		client: b.client,
		notify: async () => {
			if (fail) throw Error("transient journal failure");
			return "notice-after-recovery";
		},
	});
	cleanups.push(() => jobs.close());
	const job = await jobs.start(request);
	jobs.resume();
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id).deliveredEntryId).toBeNull();
	expect(jobs.get(job.id).deliveryError).toBeString();
	fail = false;
	await jobs.recover();
	expect(jobs.get(job.id).deliveredEntryId).toBe("notice-after-recovery");
	await jobs.close();
	await jobs.close();
});

test("confirmed oversized output becomes an import failure and allows the next explicit generation", async () => {
	const f = fixture();
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename: "oversized.png" },
		}),
		download: async () => {
			throw new Ima2Error("BODY_TOO_LARGE", "too large");
		},
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id)).toMatchObject({
		state: "failed",
		artifact: null,
		resultFilename: "oversized.png",
	});
	await jobs.start({
		...request,
		requestId: "other-request",
		callId: "other-call",
		prompt: "A small simple image",
	});
	expect(b.submits).toHaveLength(2);
});

test("cancellation intent is durable while an earlier read is still blocked", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let reads = 0;
	const b = backend({
		read: async (id) => {
			if (++reads === 1) {
				entered.resolve();
				await release.promise;
			}
			return { requestId: id, state: "running" };
		},
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	const read = jobs.reconcile(job.id);
	await entered.promise;
	const cancelled = jobs.cancel(job.id);
	const stored = new ImageJobStore(f.root, f.binding).get(job.id);
	release.resolve();
	await Promise.all([read, cancelled]);
	expect(stored.cancelRequested).toBe(true);
	expect(stored.state).toBe("cancelling");
});

test("upstream filenames with model-version dots and Korean prompt text remain valid provenance", async () => {
	const f = fixture();
	const filename = "gpt-5.5_1x1_20260907_나무_0.png";
	const b = backend({
		read: async (id) => ({
			requestId: id,
			state: "completed",
			result: { requestId: id, filename },
		}),
	});
	const jobs = manager(f, b.client);
	const job = await jobs.start(request);
	await jobs.reconcile(job.id);
	expect(jobs.get(job.id)).toMatchObject({
		state: "completed",
		resultFilename: filename,
	});
	expect(new ImageJobStore(f.root, f.binding).get(job.id).resultFilename).toBe(
		filename,
	);
});
