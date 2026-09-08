import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	checkedDirectory,
	fsyncDirectory,
	readRegular,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import type { ImageOwner } from "./contracts.ts";
import {
	archiveEligible,
	type ImageJob,
	originKey,
	parseJob,
	parseOwner,
} from "./image-store-schema.ts";
export type ArchiveEntry = {
	id: string;
	key: string;
	sha256: string;
	bytes: number;
};
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const serializedBytes = (value: unknown): Uint8Array =>
	new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export function parseArchiveEntry(raw: unknown): ArchiveEntry {
	if (
		!raw ||
		typeof raw !== "object" ||
		Object.keys(raw).sort().join() !== "bytes,id,key,sha256" ||
		!("id" in raw) ||
		typeof raw.id !== "string" ||
		!uuid.test(raw.id) ||
		!("key" in raw) ||
		typeof raw.key !== "string" ||
		raw.key.length > 4096 ||
		!("sha256" in raw) ||
		typeof raw.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(raw.sha256) ||
		!("bytes" in raw) ||
		typeof raw.bytes !== "number" ||
		!Number.isSafeInteger(raw.bytes) ||
		raw.bytes <= 0
	)
		throw Error("Invalid image archive entry");
	return raw as ArchiveEntry;
}
/** Only immutable records live here. A crash before the canonical link leaves a verified duplicate. */
export class ImageArchives {
	readonly directory: string;
	constructor(
		directory: string,
		private readonly owner: ImageOwner,
		private readonly maxBytes: number,
		create = true,
	) {
		this.directory = checkedDirectory(join(directory, "archives"), create);
	}
	private record(bytes: Uint8Array): ImageJob {
		const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (
			!raw ||
			typeof raw !== "object" ||
			Object.keys(raw).sort().join() !== "job,owner,version" ||
			!("version" in raw) ||
			raw.version !== 2 ||
			!("owner" in raw) ||
			!isDeepStrictEqual(parseOwner(raw.owner), this.owner) ||
			!("job" in raw)
		)
			throw Error("Invalid image archive schema or binding");
		const job = parseJob(raw.job, this.owner);
		if (!archiveEligible(job))
			throw Error("Invalid image archive terminal acknowledgement");
		return job;
	}
	read(entry: ArchiveEntry): ImageJob {
		parseArchiveEntry(entry);
		const bytes = readRegular(
			join(this.directory, `${entry.id}.json`),
			Math.min(entry.bytes, this.maxBytes),
		);
		if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
			throw Error("Conflicting image archive bytes");
		const job = this.record(bytes);
		if (job.id !== entry.id || originKey(job.origin) !== entry.key)
			throw Error("Conflicting image archive identity");
		return job;
	}
	encode(job: ImageJob): { entry: ArchiveEntry; bytes: Uint8Array } {
		if (!archiveEligible(job))
			throw Error(
				"Image archive requires acknowledged terminal without recoverable output",
			);
		const bytes = serializedBytes({ version: 2, owner: this.owner, job });
		return {
			bytes,
			entry: {
				id: job.id,
				key: originKey(job.origin),
				sha256: hash(bytes),
				bytes: bytes.length,
			},
		};
	}
	write(job: ImageJob): ArchiveEntry {
		const { bytes, entry } = this.encode(job);
		const path = join(this.directory, `${job.id}.json`);
		if (lstatSync(path, { throwIfNoEntry: false })) this.read(entry);
		else {
			writeExclusive(path, bytes);
			fsyncDirectory(this.directory);
		}
		return entry;
	}
	inventory(
		active: ImageJob[],
		entries: ArchiveEntry[],
	): { count: number; bytes: number } {
		let bytes = 0;
		const names = readdirSync(this.directory);
		for (const entry of entries)
			if (!names.includes(`${entry.id}.json`))
				throw Error("Missing image archive");
		for (const name of names) {
			const id = name.slice(0, -5);
			if (!name.endsWith(".json") || !uuid.test(id))
				throw Error("Unknown image archive file");
			const entry = entries.find((e) => e.id === id);
			if (entry) {
				bytes += entry.bytes;
				continue;
			}
			const retained = readRegular(join(this.directory, name), this.maxBytes);
			const job = this.record(retained);
			if (job.id !== id || !active.some((j) => isDeepStrictEqual(j, job)))
				throw Error("Orphaned or conflicting image archive identity");
			bytes += retained.length;
		}
		return { count: names.length, bytes };
	}
}
