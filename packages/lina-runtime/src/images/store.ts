import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	atomicJson,
	checkedDirectory,
	fsyncDirectory,
	readRegular,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import type { AttachmentMetadata } from "../../../lina-core/src/attachments/types.ts";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import { validateBinding } from "../../../lina-core/src/session-binding.ts";
import type {
	ImageCompletion,
	ImageJobInput,
	ImageOwner,
	ImageStoreLimits,
} from "./contracts.ts";
import {
	type ArchiveEntry,
	ImageArchives,
	parseArchiveEntry,
	serializedBytes,
} from "./image-store-archive.ts";
import {
	MAX_JOBS,
	MAX_STORE_BYTES,
	parseLegacyJob,
	terminalImageState,
} from "./image-store-legacy.ts";
import {
	assertConversationAllowance,
	conversationStoreLimits,
} from "./image-store-limits.ts";
import {
	type ImageJob,
	inputFor,
	migrateJob,
	originKey,
	parseInput,
	parseJob,
	parseOwner,
	sameImageTerminal,
	validateRecords,
} from "./image-store-schema.ts";

export type { ImageJobInput } from "./contracts.ts";
export type { ImageJobState } from "./image-store-legacy.ts";
export { terminalImageState } from "./image-store-legacy.ts";
export type { ImageJob } from "./image-store-schema.ts";

export type ImageArchiveReceipt = { sha256: string; size: number };

type Patch = Partial<
	Pick<
		ImageJob,
		| "state"
		| "endpoint"
		| "runtimeVersion"
		| "error"
		| "artifact"
		| "deliveredEntryId"
		| "cancelRequested"
		| "resultFilename"
		| "deliveryError"
		| "delivery"
	>
>;
/** One runtime lifetime owner holds writes. Filesystem reopening never grants execution authority. */
export class ImageJobStore {
	readonly owner: ImageOwner;
	private readonly path: string;
	private readonly backup: string;
	private readonly archives: ImageArchives;
	private readonly limits: ImageStoreLimits;
	private jobs: ImageJob[] = [];
	private entries: ArchiveEntry[] = [];
	private poisoned = false;
	constructor(
		root: string,
		owner: BotBinding | ImageOwner,
		limits?: ImageStoreLimits,
		requireExisting = false,
	) {
		this.owner = parseOwner(
			"kind" in owner
				? owner
				: { kind: "conversation", binding: validateBinding(owner) },
		);
		if (this.owner.kind === "life" && !limits)
			throw Error("LIFE image storage limits are required");
		this.limits = structuredClone(
			this.owner.kind === "conversation"
				? conversationStoreLimits(this.owner)
				: (limits as ImageStoreLimits),
		);
		if (
			Object.keys(this.limits).sort().join() !==
				"maxActiveBytes,maxActiveJobs,maxArchiveBytes,maxArchivedJobs,maxTotalBytes" ||
			Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n < 0)
		)
			throw Error("Invalid image storage limits");
		const dir = checkedDirectory(join(root, "images"), !requireExisting);
		this.path = join(dir, "jobs.json");
		this.backup = join(dir, "jobs.v1.backup.json");
		this.archives = new ImageArchives(
			dir,
			this.owner,
			this.limits.maxArchiveBytes,
			!requireExisting,
		);
		if (!lstatSync(this.path, { throwIfNoEntry: false })) {
			if (requireExisting) throw Error("Missing canonical image manifest");
			if (
				lstatSync(this.backup, { throwIfNoEntry: false }) ||
				readdirSync(this.archives.directory).length
			)
				throw Error("Missing canonical image manifest");
			this.save([], []);
			return;
		}
		const bytes = readRegular(
			this.path,
			Math.max(
				this.limits.maxActiveBytes,
				this.owner.kind === "conversation" ? MAX_STORE_BYTES : 0,
			),
		);
		const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (
			raw &&
			typeof raw === "object" &&
			"version" in raw &&
			raw.version === 1
		) {
			if (requireExisting)
				throw Error("Legacy image migration requires writer ownership");
			this.migrate(raw, bytes, dir);
		} else this.load(raw);
	}
	/** Linked attempts and cold LIFE readers must never initialize replacement state. */
	static openExisting(
		root: string,
		owner: BotBinding | ImageOwner,
		limits?: ImageStoreLimits,
	): ImageJobStore {
		if (
			!lstatSync(join(root, "images", "jobs.json"), { throwIfNoEntry: false })
		)
			throw Error("Missing canonical image manifest");
		return new ImageJobStore(root, owner, limits, true);
	}

	get binding(): BotBinding {
		if (this.owner.kind !== "conversation")
			throw Error("LIFE image owner has no conversation binding");
		return structuredClone(this.owner.binding);
	}
	list(): ImageJob[] {
		this.assertOpen();
		return [
			...structuredClone(this.jobs),
			...this.entries.map((e) => this.archives.read(e)),
		];
	}
	get(id: string): ImageJob {
		this.assertOpen();
		const archived = this.entries.find((e) => e.id === id);
		if (archived) return this.archives.read(archived);
		const job = this.jobs.find((j) => j.id === id);
		if (!job) throw Error("Image job not found in this owner");
		return structuredClone(job);
	}
	find(input: ImageJobInput): ImageJob | undefined {
		this.assertOpen();
		const parsed = parseInput(input, this.owner);
		const key = originKey(
			"origin" in parsed
				? parsed.origin
				: {
						kind: "conversation",
						requestId: parsed.requestId,
						callId: parsed.callId,
					},
		);
		const old = this.jobs.find((j) => originKey(j.origin) === key);
		const archived = this.entries.find((e) => e.key === key);
		const previous =
			old ?? (archived ? this.archives.read(archived) : undefined);
		if (previous && !isDeepStrictEqual(inputFor(previous), parsed))
			throw Error("Image request ID conflict");
		return previous ? structuredClone(previous) : undefined;
	}
	create(input: ImageJobInput): ImageJob {
		const parsed = parseInput(input, this.owner);
		const previous = this.find(parsed);
		if (previous) return previous;
		const stamp = new Date().toISOString();
		const life = "origin" in parsed;
		const job = parseJob(
			{
				provider: parsed.provider,
				model: parsed.model,
				prompt: parsed.prompt,
				owner: this.owner,
				origin: life
					? parsed.origin
					: {
							kind: "conversation",
							requestId: parsed.requestId,
							callId: parsed.callId,
						},
				reference: life ? parsed.reference : null,
				requestId: life ? null : parsed.requestId,
				callId: life ? null : parsed.callId,
				sourceArtifactId: life ? null : parsed.sourceArtifactId,
				id: randomUUID(),
				state: "prepared",
				endpoint: null,
				runtimeVersion: null,
				createdAt: stamp,
				updatedAt: stamp,
				error: null,
				cancelRequested: false,
				resultFilename: null,
				deliveryError: null,
				artifact: null,
				deliveredEntryId: null,
				delivery: { kind: "pending" },
				artifactRecovery: null,
			},
			this.owner,
		);
		this.save([...this.jobs, job], this.entries);
		return structuredClone(job);
	}
	update(id: string, patch: Patch): ImageJob {
		this.assertActive(id);
		const current = this.get(id);
		if (
			Object.keys(patch).some(
				(k) =>
					![
						"state",
						"endpoint",
						"runtimeVersion",
						"error",
						"artifact",
						"deliveredEntryId",
						"cancelRequested",
						"resultFilename",
						"deliveryError",
						"delivery",
					].includes(k),
			)
		)
			throw Error("Invalid image update fields");
		if (
			terminalImageState(current.state) &&
			Object.keys(patch).some(
				(k) => !["deliveredEntryId", "deliveryError", "delivery"].includes(k),
			)
		)
			throw Error("Image job is terminal");
		for (const key of ["endpoint", "runtimeVersion", "resultFilename"] as const)
			if (
				current[key] !== null &&
				patch[key] !== undefined &&
				current[key] !== patch[key]
			)
				throw Error("Image provenance conflict");
		let delivery: ImageCompletion = patch.delivery ?? current.delivery;
		if (patch.deliveredEntryId !== undefined) {
			if (this.owner.kind !== "conversation")
				throw Error("Foreign image completion receipt");
			delivery = patch.deliveredEntryId
				? { kind: "conversation", entryId: patch.deliveredEntryId }
				: { kind: "pending" };
			if (patch.delivery && !isDeepStrictEqual(delivery, patch.delivery))
				throw Error("Image delivery conflict");
		}
		if (
			current.delivery.kind !== "pending" &&
			!isDeepStrictEqual(current.delivery, delivery)
		)
			throw Error("Image delivery receipt is immutable");
		const job = parseJob(
			{
				...current,
				...patch,
				delivery,
				deliveredEntryId:
					delivery.kind === "conversation" ? delivery.entryId : null,
				updatedAt: new Date().toISOString(),
			},
			this.owner,
		);
		this.save(
			this.jobs.map((j) => (j.id === id ? job : j)),
			this.entries,
		);
		return structuredClone(job);
	}
	/** Commit a receipt against the terminal generation that the completion port observed. */
	acknowledgeCompletion(
		observed: ImageJob,
		receipt: ImageCompletion,
	): ImageJob {
		this.assertActive(observed.id);
		const current = this.get(observed.id);
		if (sameImageTerminal(current, observed))
			return this.update(current.id, {
				delivery: receipt,
				deliveryError: null,
			});
		if (
			observed.owner.kind !== "life" ||
			observed.state !== "failed" ||
			observed.artifactRecovery !== null ||
			current.state !== "completed" ||
			!current.artifactRecovery ||
			observed.resultFilename !== current.resultFilename ||
			observed.error !== current.artifactRecovery.error
		)
			throw Error("Stale image terminal receipt");
		const previous = current.artifactRecovery.delivery;
		if (previous.kind !== "pending" && !isDeepStrictEqual(previous, receipt))
			throw Error("Image recovery receipt is immutable");
		const job = parseJob(
			{
				...current,
				artifactRecovery: { ...current.artifactRecovery, delivery: receipt },
				updatedAt: new Date().toISOString(),
			},
			this.owner,
		);
		this.save(
			this.jobs.map((item) => (item.id === job.id ? job : item)),
			this.entries,
		);
		return structuredClone(job);
	}
	recordCompletionError(observed: ImageJob, error: string): ImageJob {
		const current = this.get(observed.id);
		return sameImageTerminal(current, observed)
			? this.update(current.id, { deliveryError: error })
			: current;
	}
	/** The runner verifies imported bytes before invoking this one allowed terminal transition. */
	recoverArtifact(id: string, artifact: AttachmentMetadata): ImageJob {
		this.assertActive(id);
		const current = this.get(id);
		if (
			current.owner.kind !== "life" ||
			current.state !== "failed" ||
			!current.resultFilename ||
			!current.endpoint ||
			!current.runtimeVersion ||
			current.artifact
		)
			throw Error(
				"Image artifact recovery requires a failed LIFE job with known result provenance",
			);
		const job = parseJob(
			{
				...current,
				state: "completed",
				artifact,
				error: null,
				delivery: { kind: "pending" },
				deliveryError: null,
				artifactRecovery: {
					failedAt: current.updatedAt,
					error: current.error,
					delivery: current.delivery,
				},
				updatedAt: new Date().toISOString(),
			},
			this.owner,
		);
		this.save(
			this.jobs.map((j) => (j.id === id ? job : j)),
			this.entries,
		);
		return structuredClone(job);
	}
	archive(id: string): ImageJob {
		const current = this.get(id);
		if (this.entries.some((e) => e.id === id)) return current;
		const receipt = this.prepareArchiveReceipt(id);
		const encoded = this.archives.encode(current);
		if (
			encoded.entry.sha256 !== receipt.sha256 ||
			encoded.entry.bytes !== receipt.size
		)
			throw Error("Conflicting prospective image archive receipt");
		const jobs = this.jobs.filter((j) => j.id !== id);
		const entries = [...this.entries, encoded.entry];
		this.checkLimits(jobs, entries, encoded.entry);
		try {
			this.archives.write(current);
			this.save(jobs, entries);
		} catch (error) {
			this.poisoned = true;
			throw error;
		}
		return current;
	}
	/** Encodes the exact immutable archive without writing it. */
	prepareArchiveReceipt(id: string): ImageArchiveReceipt {
		const entry = this.archives.encode(this.get(id)).entry;
		return { sha256: entry.sha256, size: entry.bytes };
	}
	/** Re-reads the immutable archive; callers never receive its filesystem path. */
	archiveReceipt(id: string): ImageArchiveReceipt {
		this.assertOpen();
		const entry = this.entries.find((item) => item.id === id);
		if (!entry) throw Error("Image archive is not retained");
		this.archives.read(entry);
		return { sha256: entry.sha256, size: entry.bytes };
	}
	usage() {
		this.assertOpen();
		const inventory = this.archives.inventory(this.jobs, this.entries);
		const activeBytes = serializedBytes(
			this.manifest(this.jobs, this.entries),
		).length;
		const backupBytes = lstatSync(this.backup, { throwIfNoEntry: false })
			? readRegular(this.backup, MAX_STORE_BYTES).length
			: 0;
		return {
			activeJobs: this.jobs.length,
			archivedJobs: inventory.count,
			activeBytes,
			archiveBytes: inventory.bytes,
			backupBytes,
			totalBytes: activeBytes + inventory.bytes + backupBytes,
		};
	}
	private assertActive(id: string) {
		this.assertOpen();
		if (this.entries.some((e) => e.id === id)) {
			this.get(id);
			throw Error("Image archive is immutable");
		}
	}
	private manifest(jobs: ImageJob[], archives: ArchiveEntry[]) {
		return { version: 2, owner: this.owner, jobs, archives };
	}
	private checkLimits(
		jobs: ImageJob[],
		entries: ArchiveEntry[],
		planned?: ArchiveEntry,
	): void {
		if (this.owner.kind === "conversation") {
			const archived = entries.map(
				(entry) =>
					this.jobs.find((job) => job.id === entry.id) ??
					this.archives.read(entry),
			);
			assertConversationAllowance(this.owner, [...jobs, ...archived]);
		}
		const inventory = this.archives.inventory(this.jobs, this.entries);
		const newArchive =
			planned &&
			!lstatSync(join(this.archives.directory, `${planned.id}.json`), {
				throwIfNoEntry: false,
			})
				? planned
				: undefined;
		const archiveBytes = inventory.bytes + (newArchive?.bytes ?? 0);
		const count = inventory.count + (newArchive ? 1 : 0);
		const activeBytes = serializedBytes(this.manifest(jobs, entries)).length;
		const backupBytes = lstatSync(this.backup, { throwIfNoEntry: false })
			? readRegular(this.backup, MAX_STORE_BYTES).length
			: 0;
		if (
			jobs.length > this.limits.maxActiveJobs ||
			count > this.limits.maxArchivedJobs ||
			activeBytes > this.limits.maxActiveBytes ||
			archiveBytes > this.limits.maxArchiveBytes ||
			activeBytes + archiveBytes + backupBytes > this.limits.maxTotalBytes ||
			(this.owner.kind === "conversation" &&
				jobs.length + entries.length > MAX_JOBS)
		)
			throw Error("Image job storage limit reached");
	}
	private assertOpen(): void {
		if (this.poisoned)
			throw Error("Image store has an unresolved write; reopen before use");
	}
	private save(jobs: ImageJob[], entries: ArchiveEntry[]): void {
		this.assertOpen();
		this.checkLimits(jobs, entries);
		try {
			atomicJson(this.path, this.manifest(jobs, entries));
		} catch (error) {
			// Rename may already have committed a UUID. Stale memory must never replace it.
			this.poisoned = true;
			throw error;
		}
		this.jobs = jobs;
		this.entries = entries;
	}
	private load(raw: unknown): void {
		if (
			!raw ||
			typeof raw !== "object" ||
			Object.keys(raw).sort().join() !== "archives,jobs,owner,version" ||
			!("version" in raw) ||
			raw.version !== 2 ||
			!("owner" in raw) ||
			!isDeepStrictEqual(parseOwner(raw.owner), this.owner) ||
			!("jobs" in raw) ||
			!Array.isArray(raw.jobs) ||
			!("archives" in raw) ||
			!Array.isArray(raw.archives)
		)
			throw Error("Invalid image store binding or schema");
		this.jobs = raw.jobs.map((j) => parseJob(j, this.owner));
		this.entries = raw.archives.map(parseArchiveEntry);
		validateRecords(this.list());
		this.checkLimits(this.jobs, this.entries);
	}
	private migrate(raw: object, bytes: Uint8Array, directory: string): void {
		if (
			this.owner.kind !== "conversation" ||
			bytes.length > MAX_STORE_BYTES ||
			Object.keys(raw).sort().join() !== "binding,jobs,version" ||
			!("binding" in raw) ||
			!isDeepStrictEqual(validateBinding(raw.binding), this.owner.binding) ||
			!("jobs" in raw) ||
			!Array.isArray(raw.jobs) ||
			raw.jobs.length > MAX_JOBS
		)
			throw Error("Invalid image store binding or schema");
		const legacy = raw.jobs.map(parseLegacyJob);
		if (
			new Set(legacy.map((j) => `${j.requestId}\0${j.callId}`)).size !==
			legacy.length
		)
			throw Error("Invalid image store records");
		const jobs = legacy.map((j) => migrateJob(j, this.owner));
		validateRecords(jobs);
		this.checkLimits(jobs, []);
		if (lstatSync(this.backup, { throwIfNoEntry: false })) {
			if (!Buffer.from(readRegular(this.backup, MAX_STORE_BYTES)).equals(bytes))
				throw Error("Conflicting legacy image backup");
		} else {
			writeExclusive(this.backup, bytes);
			fsyncDirectory(directory);
		}
		this.save(jobs, []);
	}
}
