import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageJobStore } from "../src/images/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const owner = { kind: "life" as const, worldId: "world-a", agentId: "agent-a" };
const limits = {
	maxActiveJobs: 2,
	maxArchivedJobs: 300,
	maxActiveBytes: 1_000_000,
	maxArchiveBytes: 2_000_000,
	maxTotalBytes: 3_000_000,
};
const input = {
	provider: "fixture",
	model: "image-one",
	prompt: "Approved identity",
	origin: {
		kind: "life" as const,
		intentId: "intent-a",
		attemptId: "attempt-a",
		briefDigest: "a".repeat(64),
	},
	reference: null,
};

test("cold existing-store validation never recreates a missing archive directory", () => {
	for (const kind of ["valid", "corrupt", "foreign"] as const) {
		const root = mkdtempSync(join(tmpdir(), "lina-image-cold-"));
		roots.push(root);
		new ImageJobStore(root, owner, limits);
		if (kind === "corrupt") writeFileSync(join(root, "images/jobs.json"), "{");
		rmSync(join(root, "images/archives"), { recursive: true });
		const before = readdirSync(root, { recursive: true });
		expect(() =>
			ImageJobStore.openExisting(
				root,
				kind === "foreign" ? { ...owner, worldId: "foreign" } : owner,
				limits,
			),
		).toThrow();
		expect(readdirSync(root, { recursive: true })).toEqual(before);
	}
});

test("cold conversation access cannot trigger legacy migration", () => {
	const f = fixture();
	const original = JSON.stringify({
		version: 1,
		binding: f.binding,
		jobs: [legacy("cancelled", "notice")],
	});
	writeFileSync(f.file, original);
	const before = readdirSync(f.root, { recursive: true });
	expect(() => ImageJobStore.openExisting(f.root, f.binding)).toThrow();
	expect(readFileSync(f.file, "utf8")).toBe(original);
	expect(readdirSync(f.root, { recursive: true })).toEqual(before);
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-v2-"));
	roots.push(root);
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: randomUUID(),
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	mkdirSync(join(root, "images"));
	return {
		root,
		binding,
		file: join(root, "images/jobs.json"),
		backup: join(root, "images/jobs.v1.backup.json"),
	};
}
function legacy(state: string, deliveredEntryId: string | null = null) {
	const id = randomUUID();
	return {
		requestId: id,
		callId: "call",
		provider: "fixture",
		model: "image-one",
		prompt: "A blue circle",
		sourceArtifactId: null,
		id,
		state,
		endpoint: state === "prepared" ? null : "http://127.0.0.1:45678",
		runtimeVersion: state === "prepared" ? null : "3.14.0",
		createdAt: "2026-09-07T00:00:00.000Z",
		updatedAt: "2026-09-07T00:01:00.000Z",
		error: state === "failed" ? "failed import" : null,
		cancelRequested: state === "cancelling" || state === "cancelled",
		resultFilename:
			state === "failed" || state === "completed" ? "gpt-5.5_나무.png" : null,
		deliveryError: deliveredEntryId ? null : "pending notice",
		artifact:
			state === "completed"
				? {
						id,
						name: "result.png",
						mime: "image/png",
						size: 68,
						sha256: "b".repeat(64),
					}
				: null,
		deliveredEntryId,
	};
}
test("v1 migration preserves every state and delivery value plus immutable original bytes", () => {
	const f = fixture();
	const records = [
		"prepared",
		"submitting",
		"queued",
		"running",
		"post_processing",
		"uncertain",
		"cancelling",
		"completed",
		"failed",
		"cancelled",
	].flatMap((state) => [legacy(state), legacy(state, `notice-${state}`)]);
	const original = `${JSON.stringify({ version: 1, binding: f.binding, jobs: records }, null, 2)}\n`;
	writeFileSync(f.file, original);
	const store = new ImageJobStore(f.root, f.binding);
	expect(JSON.parse(readFileSync(f.file, "utf8")).version).toBe(2);
	expect(readFileSync(f.backup, "utf8")).toBe(original);
	for (const record of records) {
		expect(store.get(record.id)).toMatchObject(record);
		expect(store.get(record.id).owner).toEqual({
			kind: "conversation",
			binding: f.binding,
		});
		expect(store.get(record.id).origin).toEqual({
			kind: "conversation",
			requestId: record.requestId,
			callId: record.callId,
		});
		expect(store.get(record.id).delivery).toEqual(
			record.deliveredEntryId
				? { kind: "conversation", entryId: record.deliveredEntryId }
				: { kind: "pending" },
		);
	}
	expect(new ImageJobStore(f.root, f.binding).list()).toEqual(store.list());
	expect(readFileSync(f.backup, "utf8")).toBe(original);
});
test("invalid legacy records, duplicates, binding and count reject before any migration write", () => {
	for (const damage of [
		"record",
		"duplicate-id",
		"duplicate-key",
		"binding",
		"count",
	]) {
		const f = fixture();
		const record = legacy("uncertain");
		const second = { ...record, id: randomUUID() };
		const raw = { version: 1, binding: f.binding, jobs: [record] };
		if (damage === "record") Object.assign(record, { surprise: true });
		if (damage === "duplicate-id") raw.jobs.push(record);
		if (damage === "duplicate-key") raw.jobs.push(second);
		if (damage === "binding") raw.binding = { ...f.binding, botId: "foreign" };
		if (damage === "count")
			raw.jobs = Array.from({ length: 257 }, () => legacy("cancelled"));
		const bytes = JSON.stringify(raw);
		writeFileSync(f.file, bytes);
		expect(() => new ImageJobStore(f.root, f.binding)).toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(bytes);
		expect(existsSync(f.backup)).toBe(false);
	}
});
test("corrupt or foreign v2 never falls back to its original v1 snapshot", () => {
	const f = fixture();
	writeFileSync(
		f.file,
		JSON.stringify({
			version: 1,
			binding: f.binding,
			jobs: [legacy("failed")],
		}),
	);
	new ImageJobStore(f.root, f.binding);
	for (const bytes of [
		'{"version":2',
		JSON.stringify({ version: 2, owner, jobs: [], archives: [] }),
	]) {
		writeFileSync(f.file, bytes);
		expect(() => new ImageJobStore(f.root, f.binding)).toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(bytes);
	}
});
test("LIFE dedupe freezes real origin and reference identity without conversation keys", () => {
	const f = fixture();
	const store = new ImageJobStore(f.root, owner, limits);
	const job = store.create(input);
	expect(job.origin).toEqual(input.origin);
	expect(job.requestId).toBeNull();
	expect(job.callId).toBeNull();
	expect(store.create(input)).toEqual(job);
	for (const changed of [
		{ ...input, prompt: "Changed" },
		{ ...input, origin: { ...input.origin, briefDigest: "b".repeat(64) } },
	])
		expect(() => store.create(changed)).toThrow("conflict");
	expect(() =>
		store.create({
			requestId: "fake-life",
			callId: "fake",
			provider: "fixture",
			model: "image",
			prompt: "fake",
			sourceArtifactId: null,
		}),
	).toThrow();
	expect(
		() => new ImageJobStore(f.root, { ...owner, agentId: "foreign" }, limits),
	).toThrow();
});
test("257 LIFE identities survive terminal archival, reopen and replay without using the conversation cap", () => {
	const f = fixture();
	let store = new ImageJobStore(f.root, owner, limits);
	const ids: string[] = [];
	for (let n = 0; n < 257; n++) {
		const job = store.create({
			...input,
			origin: { ...input.origin, attemptId: `attempt-${n}` },
		});
		ids.push(job.id);
		store.update(job.id, { state: "cancelled" });
		store.update(job.id, {
			delivery: { kind: "life", receiptId: `receipt-${n}` },
		});
		store.archive(job.id);
	}
	store = new ImageJobStore(f.root, owner, limits);
	expect(store.list()).toHaveLength(257);
	for (let n = 0; n < 257; n++)
		expect(
			store.create({
				...input,
				origin: { ...input.origin, attemptId: `attempt-${n}` },
			}).id,
		).toBe(ids[n] ?? "missing fixture id");
	expect(store.usage().activeJobs).toBe(0);
	expect(store.usage().archivedJobs).toBe(257);
	expect(store.usage().archiveBytes).toBeGreaterThan(0);
});
test("archives require acknowledged terminals and reject missing or altered immutable records on get/open", () => {
	const f = fixture();
	const store = new ImageJobStore(f.root, owner, limits);
	const job = store.create(input);
	expect(() => store.archive(job.id)).toThrow();
	store.update(job.id, { state: "cancelled" });
	expect(() => store.archive(job.id)).toThrow();
	store.update(job.id, { delivery: { kind: "life", receiptId: "receipt" } });
	store.archive(job.id);
	expect(() => store.update(job.id, { deliveryError: "changed" })).toThrow();
	const path = join(f.root, "images/archives", `${job.id}.json`);
	const bytes = readFileSync(path);
	writeFileSync(path, "{}");
	expect(() => store.get(job.id)).toThrow();
	expect(() => new ImageJobStore(f.root, owner, limits)).toThrow();
	writeFileSync(path, bytes);
	rmSync(path);
	expect(() => store.get(job.id)).toThrow();
	expect(() => new ImageJobStore(f.root, owner, limits)).toThrow();
});
test("active/archive byte and count ceilings fail without deleting or forgetting old identity", () => {
	const f = fixture();
	const store = new ImageJobStore(f.root, owner, {
		...limits,
		maxActiveJobs: 1,
		maxArchivedJobs: 0,
	});
	const job = store.create(input);
	expect(() =>
		store.create({
			...input,
			origin: { ...input.origin, attemptId: "second" },
		}),
	).toThrow("limit");
	store.update(job.id, {
		state: "cancelled",
		delivery: { kind: "life", receiptId: "receipt" },
	});
	expect(() => store.archive(job.id)).toThrow("limit");
	expect(store.get(job.id).id).toBe(job.id);
	const b = fixture();
	const small = new ImageJobStore(b.root, owner, {
		...limits,
		maxActiveBytes: 300,
	});
	expect(() => small.create(input)).toThrow("limit");
	expect(small.list()).toHaveLength(0);
});

test("interrupted archive linking reuses the immutable record; duplicate tombstones reject", () => {
	const f = fixture();
	const store = new ImageJobStore(f.root, owner, limits);
	const job = store.create(input);
	store.update(job.id, {
		state: "cancelled",
		delivery: { kind: "life", receiptId: "receipt" },
	});
	const before = readFileSync(f.file);
	store.archive(job.id);
	const archive = readFileSync(
		join(f.root, "images/archives", `${job.id}.json`),
	);
	writeFileSync(f.file, before);
	const reopened = new ImageJobStore(f.root, owner, limits);
	expect(reopened.usage().archivedJobs).toBe(1);
	reopened.archive(job.id);
	expect(
		readFileSync(join(f.root, "images/archives", `${job.id}.json`)),
	).toEqual(archive);
	const manifest = JSON.parse(readFileSync(f.file, "utf8"));
	manifest.archives.push(manifest.archives[0]);
	writeFileSync(f.file, JSON.stringify(manifest));
	expect(() => new ImageJobStore(f.root, owner, limits)).toThrow("records");
});

test("interrupted v1 migration accepts only the exact durable backup; missing canonical never recreates history", () => {
	const f = fixture();
	const raw = JSON.stringify({
		version: 1,
		binding: f.binding,
		jobs: [legacy("running")],
	});
	writeFileSync(f.file, raw);
	writeFileSync(f.backup, raw);
	const store = new ImageJobStore(f.root, f.binding);
	expect(store.list()).toHaveLength(1);
	expect(readFileSync(f.backup, "utf8")).toBe(raw);
	rmSync(f.file);
	expect(() => new ImageJobStore(f.root, f.binding)).toThrow("canonical");
	writeFileSync(f.file, raw);
	writeFileSync(f.backup, `${raw} `);
	expect(() => new ImageJobStore(f.root, f.binding)).toThrow("backup");
	expect(readFileSync(f.file, "utf8")).toBe(raw);
});

test("strict v2 rejects forged owner/origin/delivery/artifact fields without falling back", () => {
	for (const damage of [
		"owner",
		"origin",
		"reference",
		"receipt",
		"artifact",
		"extra",
	]) {
		const f = fixture();
		const store = new ImageJobStore(f.root, owner, limits);
		store.create(input);
		const raw = JSON.parse(readFileSync(f.file, "utf8"));
		const record = raw.jobs[0];
		if (damage === "owner") record.owner.worldId = "foreign";
		if (damage === "origin") record.requestId = "fake-conversation";
		if (damage === "reference")
			record.reference = {
				owner: { kind: "agent", agentId: "agent-a" },
				referenceId: "ref",
				assetId: "asset",
				sha256: "wrong",
				mime: "image/png",
				size: 1,
			};
		if (damage === "receipt")
			record.delivery = { kind: "conversation", entryId: "forged" };
		if (damage === "artifact") record.resultFilename = "../escape.png";
		if (damage === "extra") record.extra = true;
		const bytes = JSON.stringify(raw);
		writeFileSync(f.file, bytes);
		expect(() => new ImageJobStore(f.root, owner, limits)).toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(bytes);
	}
});

test("LIFE archive byte and total byte ceilings retain acknowledged active records", () => {
	for (const kind of ["archive", "total"]) {
		const f = fixture();
		let store = new ImageJobStore(f.root, owner, limits);
		const job = store.create(input);
		store.update(job.id, {
			state: "cancelled",
			delivery: { kind: "life", receiptId: "receipt" },
		});
		const bytes = readFileSync(f.file);
		store = new ImageJobStore(f.root, owner, {
			...limits,
			...(kind === "archive"
				? { maxArchiveBytes: 1 }
				: { maxTotalBytes: bytes.length }),
		});
		expect(() => store.archive(job.id)).toThrow("limit");
		expect(readFileSync(f.file)).toEqual(bytes);
		expect(store.get(job.id).id).toBe(job.id);
	}
});

test("linked recovery opens only an existing canonical manifest without creating replacement state", () => {
	const f = fixture();
	expect(() => ImageJobStore.openExisting(f.root, owner, limits)).toThrow(
		"canonical",
	);
	expect(existsSync(f.file)).toBe(false);
	const store = new ImageJobStore(f.root, owner, limits);
	const job = store.create(input);
	expect(ImageJobStore.openExisting(f.root, owner, limits).get(job.id)).toEqual(
		job,
	);
	rmSync(f.file);
	expect(() => ImageJobStore.openExisting(f.root, owner, limits)).toThrow(
		"canonical",
	);
	expect(existsSync(f.file)).toBe(false);
});

test("conversation archive movement never raises the original 256 identity ceiling", () => {
	const f = fixture();
	const records = Array.from({ length: 256 }, () =>
		legacy("cancelled", "notice"),
	);
	writeFileSync(
		f.file,
		JSON.stringify({ version: 1, binding: f.binding, jobs: records }),
	);
	const store = new ImageJobStore(f.root, f.binding);
	const first = records[0];
	if (!first) throw Error("Missing fixture");
	store.archive(first.id);
	expect(() =>
		store.create({
			requestId: "new",
			callId: "new",
			provider: "fixture",
			model: "model",
			prompt: "new",
			sourceArtifactId: null,
		}),
	).toThrow("limit");
	expect(new ImageJobStore(f.root, f.binding).list()).toHaveLength(256);
});

test("legacy manifest byte ceiling rejects unchanged before creating a migration backup", () => {
	const f = fixture();
	const bytes = " ".repeat(8 * 1024 * 1024 + 1);
	writeFileSync(f.file, bytes);
	expect(() => new ImageJobStore(f.root, f.binding)).toThrow();
	expect(readFileSync(f.file, "utf8")).toBe(bytes);
	expect(existsSync(f.backup)).toBe(false);
});

test("v1 migration retains the original duplicate-key validation before rewriting keys", () => {
	const f = fixture();
	const first = { ...legacy("failed"), requestId: "a\u0000b", callId: "c" };
	const second = { ...legacy("cancelled"), requestId: "a", callId: "b\u0000c" };
	const bytes = JSON.stringify({
		version: 1,
		binding: f.binding,
		jobs: [first, second],
	});
	writeFileSync(f.file, bytes);
	expect(() => new ImageJobStore(f.root, f.binding)).toThrow("records");
	expect(readFileSync(f.file, "utf8")).toBe(bytes);
	expect(existsSync(f.backup)).toBe(false);
});

test("archive dedupe supports the full bounded origin length after JSON escaping", () => {
	const f = fixture();
	const store = new ImageJobStore(f.root, owner, limits);
	const escaped = {
		...input,
		origin: {
			...input.origin,
			intentId: "\u0000".repeat(256),
			attemptId: "\u0000".repeat(256),
		},
	};
	const job = store.create(escaped);
	store.update(job.id, {
		state: "cancelled",
		delivery: { kind: "life", receiptId: "receipt" },
	});
	store.archive(job.id);
	expect(
		ImageJobStore.openExisting(f.root, owner, limits).create(escaped).id,
	).toBe(job.id);
});

test("repair1 migration preserves a valid near-8-MiB v1 store and accounts v2 overhead separately", () => {
	const f = fixture();
	const records = Array.from({ length: 256 }, () => ({
		...legacy("cancelled", "notice"),
		prompt: "가".repeat(10700),
	}));
	const original = JSON.stringify({
		version: 1,
		binding: f.binding,
		jobs: records,
	});
	expect(Buffer.byteLength(original)).toBeLessThanOrEqual(8 * 1024 * 1024);
	expect(Buffer.byteLength(original)).toBeGreaterThan(8_300_000);
	writeFileSync(f.file, original);
	const store = new ImageJobStore(f.root, f.binding);
	expect(readFileSync(f.file).length).toBeGreaterThan(8 * 1024 * 1024);
	expect(readFileSync(f.backup, "utf8")).toBe(original);
	for (const record of records)
		expect(store.get(record.id)).toMatchObject(record);
	const reopened = ImageJobStore.openExisting(f.root, f.binding);
	expect(reopened.list()).toEqual(store.list());
	const usage = reopened.usage();
	expect(usage.activeBytes).toBe(readFileSync(f.file).length);
	expect(usage.backupBytes).toBe(Buffer.byteLength(original));
	expect(usage.totalBytes).toBe(usage.activeBytes + usage.backupBytes);
	expect(() =>
		reopened.create({
			requestId: "extra",
			callId: "extra",
			provider: "fixture",
			model: "image-one",
			prompt: "new",
			sourceArtifactId: null,
		}),
	).toThrow("limit");
	const first = records[0];
	if (!first) throw Error("Missing fixture");
	reopened.archive(first.id);
	expect(
		ImageJobStore.openExisting(f.root, f.binding).get(first.id),
	).toMatchObject(first);
	const archivedUsage = reopened.usage();
	expect(archivedUsage.totalBytes).toBe(
		readFileSync(f.file).length +
			readFileSync(f.backup).length +
			readFileSync(join(f.root, "images/archives", `${first.id}.json`)).length,
	);
});

test("repair1 v2 overhead allowance cannot fund additional conversation content", () => {
	const f = fixture();
	const records = Array.from({ length: 255 }, () => ({
		...legacy("cancelled", "notice"),
		prompt: "가".repeat(10700),
	}));
	// Keep the original document valid but leave less room than a maximum-size new prompt.
	for (let i = 0; i < 3; i++) {
		const record = records[i];
		if (record) record.prompt = "가".repeat(16000);
	}
	const original = JSON.stringify({
		version: 1,
		binding: f.binding,
		jobs: records,
	});
	expect(Buffer.byteLength(original)).toBeLessThanOrEqual(8 * 1024 * 1024);
	writeFileSync(f.file, original);
	const store = new ImageJobStore(f.root, f.binding);
	const before = readFileSync(f.file);
	expect(() =>
		store.create({
			requestId: "last",
			callId: "last",
			provider: "fixture",
			model: "image-one",
			prompt: "가".repeat(16000),
			sourceArtifactId: null,
		}),
	).toThrow("record byte/count limit");
	expect(readFileSync(f.file)).toEqual(before);
	const raw = JSON.parse(before.toString());
	for (let i = 0; i < 10; i++) raw.jobs[i].prompt = "가".repeat(16000);
	expect(
		Buffer.byteLength(
			JSON.stringify({
				version: 1,
				binding: f.binding,
				jobs: records.map((record, index) => ({
					...record,
					prompt: index < 10 ? "가".repeat(16000) : record.prompt,
				})),
			}),
		),
	).toBeGreaterThan(8 * 1024 * 1024);
	writeFileSync(f.file, JSON.stringify(raw));
	expect(() => {
		ImageJobStore.openExisting(f.root, f.binding);
	}).toThrow("record byte/count limit");
});
