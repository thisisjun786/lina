import type { DatabaseSync } from "node:sqlite";
import type { LifeConfig } from "./authoring-types.ts";
import type {
	ImageAccountingBinding,
	ImageAccountingSource,
	ImageArchiveRecord,
	ImageByteReceipt,
	ImageCountRecord,
	ImageOutputReceipt,
	ImageReservationInput,
	ImageSettlement,
	ImageStorageRecord,
	ImageUsageSnapshot,
} from "./image-accounting-types.ts";
import {
	accountingConfig,
	accountingSettings,
	jsonBytes,
	parseImageArchive,
	parseImageBinding,
	parseImageBytes,
	parseImageCount,
	parseImageOutput,
	parseImageReservation,
	parseImageSettlement,
	parseImageStorage,
	sumImageIntegers,
	validateImageRecords,
} from "./image-accounting-validation.ts";
import type { LifeImageSettings } from "./image-types.ts";
import {
	canonicalLifeJson,
	digest,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";

/** Composed/migrated only by WorldStore after its prior-schema audit. */
export const IMAGE_ACCOUNTING_SCHEMA = `
CREATE TABLE life_image_counts (
 world_id TEXT NOT NULL REFERENCES worlds(id), attempt_id TEXT NOT NULL,
 job_id TEXT NOT NULL UNIQUE, binding_digest TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,attempt_id)
) STRICT;
CREATE TABLE life_image_storage (
 world_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,attempt_id),
 FOREIGN KEY(world_id,attempt_id) REFERENCES life_image_counts(world_id,attempt_id)
) STRICT;
CREATE TABLE life_image_archives (
 world_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,attempt_id),
 FOREIGN KEY(world_id,attempt_id) REFERENCES life_image_counts(world_id,attempt_id)
) STRICT;
`;
const COUNT_COLUMNS =
	"world_id,attempt_id,job_id,binding_digest,record_json,digest";
const RECORD_COLUMNS = "world_id,attempt_id,record_json,digest";
type Row = {
	world_id: string;
	attempt_id: string;
	record_json: string;
	digest: string;
};
type CountRow = Row & { job_id: string; binding_digest: string };
type Entry = {
	count: ImageCountRecord;
	storage: ImageStorageRecord;
	archive: ImageArchiveRecord | null;
};

/** WorldStore owns BEGIN IMMEDIATE/COMMIT for mutations and snapshot transactions for reads.
 * No method performs I/O outside SQLite or grants permission to generate by itself.
 * beforeSubmit MUST commit successfully immediately before the synchronous fetch handoff.
 * The caller must supply verified file/manifest receipts; this ledger does not read bytes. */
export class ImageAccounting {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: ImageAccountingSource,
		private readonly clock: () => number = Date.now,
	) {}

	prepare(input: ImageReservationInput): ImageCountRecord {
		this.writeTransaction();
		const reservation = parseImageReservation(input),
			binding = reservation.binding;
		const prior = this.find(binding);
		if (prior) {
			if (lifeDigest(prior.count.reservation) !== lifeDigest(reservation))
				throw Error("Image reservation replay conflict");
			return prior.count;
		}
		this.history(binding);
		this.verify(binding, "prepare");
		const now = revision(this.clock());
		const settings = this.settings(binding.worldId),
			config = this.config(binding.worldId);
		if (
			settings.revision !== binding.settingsRevision ||
			config.revision !== binding.configRevision
		)
			throw Error("Stale image admission revision");
		this.admission(binding, now, 1);
		const count: ImageCountRecord = {
			version: 1,
			reservation,
			createdAtMs: now,
			archived: false,
			dispatchAtMs: null,
			state: "prepared",
			terminal: null,
			resultFilename: null,
		};
		const storage: ImageStorageRecord = {
			version: 1,
			outputState: "reserved",
			asset: null,
			metadata: null,
			manifest: null,
		};
		validateImageRecords(count, storage);
		const usage = this.snapshot(binding.worldId, now).storage;
		this.capacity(settings, {
			...usage,
			activeJobs: sumImageIntegers(usage.activeJobs, 1),
			assets: sumImageIntegers(usage.assets, 1),
			totalBytes: sumImageIntegers(
				usage.totalBytes,
				reservation.outputBytes,
				reservation.metadataBytes,
				reservation.manifestBytes,
			),
		});
		this.db
			.prepare(
				"INSERT INTO life_image_counts(world_id,attempt_id,job_id,binding_digest,record_json,digest) VALUES(?,?,?,?,?,?)",
			)
			.run(
				binding.worldId,
				binding.attemptId,
				binding.jobId,
				lifeDigest(binding),
				canonicalLifeJson(count),
				lifeDigest(count),
			);
		this.db
			.prepare(
				"INSERT INTO life_image_storage(world_id,attempt_id,record_json,digest) VALUES(?,?,?,?)",
			)
			.run(
				binding.worldId,
				binding.attemptId,
				canonicalLifeJson(storage),
				lifeDigest(storage),
			);
		return count;
	}

	/** Read-only guard, useful to expose why prepared work is held. Not a POST authorization. */
	guardBeforeSubmit(input: ImageAccountingBinding): void {
		const binding = parseImageBinding(input),
			entry = this.require(binding);
		if (entry.count.dispatchAtMs !== null || entry.count.state !== "prepared")
			throw Error("Image already dispatched or settled");
		if (entry.storage.outputState !== "reserved" || entry.archive)
			throw Error("Missing active image output reservation");
		this.verify(binding, "submit");
		const now = revision(this.clock());
		this.admission(binding, now, 0);
		this.capacity(
			this.settings(binding.worldId),
			this.snapshot(binding.worldId, now).storage,
		);
	}

	/** A second invocation throws even if the first caller lost the response: never POST twice. */
	beforeSubmit(input: ImageAccountingBinding): ImageCountRecord {
		this.writeTransaction();
		const binding = parseImageBinding(input);
		this.guardBeforeSubmit(binding);
		const entry = this.require(binding),
			now = revision(this.clock());
		if (now < entry.count.createdAtMs)
			throw Error("Image dispatch clock regressed");
		entry.count.dispatchAtMs = now;
		entry.count.state = "unknown";
		this.save(entry);
		return entry.count;
	}

	settle(
		input: ImageAccountingBinding,
		outcome: ImageSettlement,
	): ImageCountRecord {
		this.writeTransaction();
		const binding = parseImageBinding(input),
			observed = parseImageSettlement(outcome),
			entry = this.require(binding),
			count = entry.count;
		if (count.terminal !== null) {
			if (
				count.terminal !== observed.kind ||
				(observed.kind === "result" &&
					count.resultFilename !== observed.resultFilename)
			)
				throw Error("Image settlement conflict");
			return count;
		}
		if (observed.kind === "no_post") {
			if (count.dispatchAtMs !== null)
				throw Error("Image dispatch marker prevents a zero-attempt refund");
			this.verify(binding, "zero");
			count.state = "released";
			count.terminal = "no_post";
			entry.storage.outputState = "released";
		} else {
			if (count.dispatchAtMs === null)
				throw Error("Missing image dispatch marker");
			if (observed.kind === "unknown") return count;
			count.state = "attempted";
			count.terminal = observed.kind;
			if (observed.kind === "result")
				count.resultFilename = observed.resultFilename;
			else entry.storage.outputState = "released";
		}
		this.save(entry);
		return count;
	}

	abandonOutput(input: ImageAccountingBinding): void {
		this.writeTransaction();
		const entry = this.recovery(input);
		if (entry.storage.outputState === "abandoned") return;
		if (entry.storage.outputState !== "reserved")
			throw Error("Cannot abandon retained image bytes");
		entry.storage.outputState = "abandoned";
		this.save(entry);
	}

	reacquireOutput(input: ImageAccountingBinding): void {
		this.writeTransaction();
		const entry = this.recovery(input);
		if (entry.storage.outputState !== "abandoned") return;
		const worldId = entry.count.reservation.binding.worldId,
			usage = this.snapshot(worldId, revision(this.clock())).storage;
		this.capacity(this.settings(worldId), {
			...usage,
			assets: sumImageIntegers(usage.assets, 1),
			totalBytes: sumImageIntegers(
				usage.totalBytes,
				entry.count.reservation.outputBytes,
			),
		});
		entry.storage.outputState = "reserved";
		this.save(entry);
	}

	/** Inventory a verified file written before its import receipt; adoption preserves UUID/hash. */
	recordOrphan(input: ImageAccountingBinding, asset: ImageOutputReceipt): void {
		this.output(input, asset, "orphan");
	}
	importOutput(input: ImageAccountingBinding, asset: ImageOutputReceipt): void {
		this.output(input, asset, "imported");
	}

	/** Caller-owned logical metadata, separate from its manifest and the output file. */
	recordMetadata(
		input: ImageAccountingBinding,
		receipt: ImageByteReceipt,
	): void {
		this.bytes(input, receipt, "metadata");
	}
	recordManifest(
		input: ImageAccountingBinding,
		receipt: ImageByteReceipt,
	): void {
		this.bytes(input, receipt, "manifest");
	}

	/** Archive/dedupe identity is retained forever. Capacity moves only after the immutable receipt exists. */
	previewArchive(
		input: ImageAccountingBinding,
		receipt: ImageByteReceipt,
		acknowledged: boolean,
	): ImageArchiveRecord {
		return this.archivePlan(input, receipt, acknowledged).archive;
	}
	archive(
		input: ImageAccountingBinding,
		receipt: ImageByteReceipt,
		acknowledged: boolean,
	): ImageArchiveRecord {
		this.writeTransaction();
		const { binding, entry, archive } = this.archivePlan(
			input,
			receipt,
			acknowledged,
		);
		if (entry.archive) return entry.archive;
		entry.count.archived = true;
		this.save(entry);
		this.db
			.prepare(
				"INSERT INTO life_image_archives(world_id,attempt_id,record_json,digest) VALUES(?,?,?,?)",
			)
			.run(
				binding.worldId,
				binding.attemptId,
				canonicalLifeJson(archive),
				lifeDigest(archive),
			);
		return archive;
	}
	private archivePlan(
		input: ImageAccountingBinding,
		receipt: ImageByteReceipt,
		acknowledged: boolean,
	): {
		binding: ImageAccountingBinding;
		entry: Entry;
		archive: ImageArchiveRecord;
	} {
		const binding = parseImageBinding(input),
			bytes = parseImageBytes(receipt),
			entry = this.require(binding);
		if (acknowledged !== true)
			throw Error("Image archive requires terminal acknowledgement");
		if (entry.archive) {
			if (lifeDigest(entry.archive.receipt) !== lifeDigest(bytes))
				throw Error("Image archive replay conflict");
			return { binding, entry, archive: entry.archive };
		}
		if (
			!entry.count.terminal ||
			entry.storage.outputState === "reserved" ||
			entry.storage.outputState === "orphan"
		)
			throw Error("Image archive requires settled terminal storage");
		if (
			!entry.storage.manifest ||
			bytes.size > entry.count.reservation.manifestBytes
		)
			throw Error("Missing or oversized original image manifest/archive");
		this.verify(binding, "archive");
		const archive: ImageArchiveRecord = {
			version: 1,
			count: { ...entry.count, archived: true },
			metadata: entry.storage.metadata,
			manifest: entry.storage.manifest,
			receipt: bytes,
			acknowledged: true,
		};
		const usage = this.snapshot(
			binding.worldId,
			revision(this.clock()),
		).storage;
		this.capacity(this.settings(binding.worldId), {
			...usage,
			activeJobs: usage.activeJobs - 1,
			archivedJobs: sumImageIntegers(usage.archivedJobs, 1),
			totalBytes: sumImageIntegers(
				usage.totalBytes,
				jsonBytes(archive),
				bytes.size,
			),
		});
		return { binding, entry, archive };
	}

	get(input: ImageAccountingBinding): ImageCountRecord {
		return this.require(parseImageBinding(input)).count;
	}
	usage(worldId: string): ImageUsageSnapshot {
		return this.snapshot(identifier(worldId), revision(this.clock()));
	}

	/** Called by WorldStore's startup transaction; validates heads, identities and original histories. */
	validate(): void {
		const rows = this.db
			.prepare(`SELECT ${COUNT_COLUMNS} FROM life_image_counts`)
			.all() as CountRow[];
		const seen = new Set<string>();
		for (const row of rows) {
			const entry = this.decode(row),
				key = canonicalLifeJson([row.world_id, row.attempt_id]);
			if (seen.has(key)) throw Error("Duplicate image count identity");
			seen.add(key);
			validateImageRecords(entry.count, entry.storage);
		}
		for (const table of [
			"life_image_storage",
			"life_image_archives",
		] as const) {
			for (const row of this.db
				.prepare(`SELECT world_id,attempt_id FROM ${table}`)
				.all()) {
				if (!seen.has(canonicalLifeJson([row["world_id"], row["attempt_id"]])))
					throw Error("Orphan image accounting record");
			}
		}
		for (const worldId of new Set(rows.map((row) => row.world_id)))
			this.snapshot(worldId, revision(this.clock()));
	}

	private verify(
		binding: ImageAccountingBinding,
		phase: Parameters<ImageAccountingSource["verifyAttempt"]>[1],
	): void {
		if (this.source.verifyAttempt(binding, phase) !== undefined)
			throw Error(
				"Image attempt verification must be synchronous and throw on denial",
			);
	}

	private writeTransaction(): void {
		if (!this.db.isTransaction)
			throw Error(
				"Image accounting requires caller BEGIN IMMEDIATE transaction",
			);
	}
	private settings(worldId: string, at?: number): LifeImageSettings {
		const value = this.source.settings(worldId, at);
		if (!value) throw Error("Missing image settings/history");
		return accountingSettings(value, worldId, at);
	}
	private config(worldId: string, at?: number): LifeConfig {
		const value = this.source.config(worldId, at);
		if (!value) throw Error("Missing image config/history");
		return accountingConfig(value, worldId, at);
	}
	private history(binding: ImageAccountingBinding): void {
		this.settings(binding.worldId, binding.settingsRevision);
		this.config(binding.worldId, binding.configRevision);
		this.verify(binding, "history");
	}
	private read<T>(row: Row, parse: (value: unknown) => T): T {
		identifier(row.world_id);
		identifier(row.attempt_id);
		digest(row.digest);
		const value = parse(JSON.parse(row.record_json));
		if (
			canonicalLifeJson(value) !== row.record_json ||
			lifeDigest(value) !== row.digest
		)
			throw Error("Corrupt image accounting JSON/digest");
		return value;
	}
	private decode(row: CountRow): Entry {
		const count = this.read(row, parseImageCount),
			binding = count.reservation.binding;
		if (
			binding.worldId !== row.world_id ||
			binding.attemptId !== row.attempt_id ||
			binding.jobId !== row.job_id ||
			lifeDigest(binding) !== row.binding_digest
		)
			throw Error("Corrupt image accounting identity");
		this.history(binding);
		const stored = this.db
			.prepare(
				`SELECT ${RECORD_COLUMNS} FROM life_image_storage WHERE world_id=? AND attempt_id=?`,
			)
			.get(row.world_id, row.attempt_id) as Row | undefined;
		if (!stored) throw Error("Missing image storage reservation");
		const storage = this.read(stored, parseImageStorage);
		validateImageRecords(count, storage);
		const archived = this.db
			.prepare(
				`SELECT ${RECORD_COLUMNS} FROM life_image_archives WHERE world_id=? AND attempt_id=?`,
			)
			.get(row.world_id, row.attempt_id) as Row | undefined;
		const archive = archived ? this.read(archived, parseImageArchive) : null;
		if (count.archived !== (archive !== null))
			throw Error("Missing or unexpected image archive");
		if (
			archive &&
			(!count.terminal ||
				!storage.manifest ||
				lifeDigest(count) !== lifeDigest(archive.count) ||
				lifeDigest(archive.metadata) !== lifeDigest(storage.metadata) ||
				lifeDigest(archive.manifest) !== lifeDigest(storage.manifest) ||
				archive.receipt.size > count.reservation.manifestBytes)
		)
			throw Error("Corrupt image archive lineage");
		return { count, storage, archive };
	}
	private find(binding: ImageAccountingBinding): Entry | null {
		const row = this.db
			.prepare(
				`SELECT ${COUNT_COLUMNS} FROM life_image_counts WHERE world_id=? AND attempt_id=?`,
			)
			.get(binding.worldId, binding.attemptId) as CountRow | undefined;
		if (!row) return null;
		const entry = this.decode(row);
		if (lifeDigest(entry.count.reservation.binding) !== lifeDigest(binding))
			throw Error("Image accounting binding conflict");
		return entry;
	}
	private require(binding: ImageAccountingBinding): Entry {
		const entry = this.find(binding);
		if (!entry) throw Error("Missing image accounting reservation");
		return entry;
	}
	private entries(worldId: string): Entry[] {
		return (
			this.db
				.prepare(
					`SELECT ${COUNT_COLUMNS} FROM life_image_counts WHERE world_id=?`,
				)
				.all(worldId) as CountRow[]
		).map((row) => this.decode(row));
	}
	private save(entry: Entry): void {
		parseImageCount(entry.count);
		parseImageStorage(entry.storage);
		validateImageRecords(entry.count, entry.storage);
		const binding = entry.count.reservation.binding;
		for (const [table, value] of [
			["life_image_counts", entry.count],
			["life_image_storage", entry.storage],
		] as const) {
			this.db
				.prepare(
					`UPDATE ${table} SET record_json=?,digest=? WHERE world_id=? AND attempt_id=?`,
				)
				.run(
					canonicalLifeJson(value),
					lifeDigest(value),
					binding.worldId,
					binding.attemptId,
				);
		}
	}
	private recovery(input: ImageAccountingBinding): Entry {
		const binding = parseImageBinding(input),
			entry = this.require(binding);
		if (entry.count.terminal !== "result")
			throw Error("Output recovery requires a known result filename");
		this.verify(binding, "recover");
		return entry;
	}
	private output(
		input: ImageAccountingBinding,
		value: ImageOutputReceipt,
		state: "orphan" | "imported",
	): void {
		this.writeTransaction();
		const asset = parseImageOutput(value),
			entry = this.recovery(input);
		if (entry.storage.asset) {
			if (lifeDigest(entry.storage.asset) !== lifeDigest(asset))
				throw Error("Image output metadata conflict");
			if (entry.storage.outputState === "imported" || state === "orphan")
				return;
		} else if (entry.storage.outputState !== "reserved")
			throw Error("Missing image output reservation; reacquire before import");
		entry.storage.asset = asset;
		entry.storage.outputState = state;
		this.save(entry);
	}
	private bytes(
		input: ImageAccountingBinding,
		value: ImageByteReceipt,
		category: "metadata" | "manifest",
	): void {
		this.writeTransaction();
		const receipt = parseImageBytes(value),
			entry = this.require(parseImageBinding(input));
		if (entry.archive) {
			if (lifeDigest(entry.storage[category]) === lifeDigest(receipt)) return;
			throw Error("Archived image metadata is immutable");
		}
		entry.storage[category] = receipt;
		this.save(entry);
	}
	private counted(
		count: ImageCountRecord,
		now: number,
		windowMs: number | null,
	): boolean {
		return (
			count.state !== "released" &&
			(count.state !== "attempted" ||
				windowMs === null ||
				(count.dispatchAtMs ?? 0) > now - windowMs)
		);
	}
	private admission(
		binding: ImageAccountingBinding,
		now: number,
		extra: number,
	): void {
		const config = this.config(binding.worldId);
		if (!config.usage) throw Error("Image allowance not configured");
		const entries = this.entries(binding.worldId),
			counts = entries.map((entry) => entry.count);
		const shared = counts.filter((count) =>
			this.counted(count, now, config.usage?.windowMs ?? null),
		).length;
		if (sumImageIntegers(shared, extra) > config.usage.maxImages)
			throw Error("World image allowance exhausted");
		const own = counts.filter(
			(count) => count.reservation.binding.kind === binding.kind,
		);
		if (binding.kind === "event") {
			if (!config.images) throw Error("Event image allowance not configured");
			const step = own.filter(
				(count) =>
					count.state !== "released" &&
					count.reservation.binding.sourceLifeRevision ===
						binding.sourceLifeRevision,
			).length;
			if (sumImageIntegers(step, extra) > config.images.maxPerStep)
				throw Error("Event image per-step allowance exhausted");
		} else {
			if (!config.avatars) throw Error("Avatar image allowance not configured");
			const window = own.filter((count) =>
				this.counted(count, now, config.usage?.windowMs ?? null),
			).length;
			if (sumImageIntegers(window, extra) > config.avatars.maxPerWindow)
				throw Error("Avatar image window allowance exhausted");
		}
	}
	private capacity(
		settings: LifeImageSettings,
		storage: Pick<
			ImageUsageSnapshot["storage"],
			"activeJobs" | "archivedJobs" | "assets" | "totalBytes"
		>,
	): void {
		for (const [key, limit] of [
			["activeJobs", "maxActiveJobs"],
			["archivedJobs", "maxArchivedJobs"],
			["assets", "maxAssets"],
			["totalBytes", "maxTotalBytes"],
		] as const) {
			revision(storage[key]);
			if (storage[key] > settings.storage[limit])
				throw Error(`Image storage capacity exceeded: ${key}`);
		}
	}
	private snapshot(worldId: string, now: number): ImageUsageSnapshot {
		const current = this.source.config(worldId);
		const windowMs = current
			? (accountingConfig(current, worldId).usage?.windowMs ?? null)
			: null;
		const result: ImageUsageSnapshot = {
			worldId,
			atMs: now,
			windowMs,
			count: { reserved: 0, consumed: 0, total: 0 },
			storage: {
				activeJobs: 0,
				archivedJobs: 0,
				assets: 0,
				outputBytes: 0,
				metadataBytes: 0,
				manifestBytes: 0,
				archiveBytes: 0,
				totalBytes: 0,
			},
		};
		for (const entry of this.entries(worldId)) {
			const { count, storage, archive } = entry,
				reservation = count.reservation;
			if (count.state === "prepared" || count.state === "unknown")
				result.count.reserved++;
			else if (this.counted(count, now, windowMs)) result.count.consumed++;
			result.storage[archive ? "archivedJobs" : "activeJobs"]++;
			if (storage.outputState === "reserved" || storage.asset)
				result.storage.assets++;
			result.storage.outputBytes = sumImageIntegers(
				result.storage.outputBytes,
				storage.asset?.size ??
					(storage.outputState === "reserved" ? reservation.outputBytes : 0),
			);
			// Keep explicit metadata/manifest growth bounds charged across archival too.
			result.storage.metadataBytes = sumImageIntegers(
				result.storage.metadataBytes,
				reservation.metadataBytes,
			);
			result.storage.manifestBytes = sumImageIntegers(
				result.storage.manifestBytes,
				reservation.manifestBytes,
			);
			if (archive)
				result.storage.archiveBytes = sumImageIntegers(
					result.storage.archiveBytes,
					jsonBytes(archive),
					archive.receipt.size,
				);
		}
		result.count.total = sumImageIntegers(
			result.count.reserved,
			result.count.consumed,
		);
		result.storage.totalBytes = sumImageIntegers(
			result.storage.outputBytes,
			result.storage.metadataBytes,
			result.storage.manifestBytes,
			result.storage.archiveBytes,
		);
		return result;
	}
}
