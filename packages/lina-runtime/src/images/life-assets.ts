import { randomUUID } from "node:crypto";
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
	checkedDirectory,
	checkedRegular,
	fsyncDirectory,
	readRegular,
	removeTemporary,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import {
	type AttachmentMetadata,
	isImageMime,
} from "../../../lina-core/src/attachments/types.ts";
import {
	hash,
	inspectContent,
	metadataShape,
	validateId,
} from "../../../lina-core/src/attachments/validation.ts";
import type { ImageOwner } from "../../../lina-core/src/world/image-types.ts";
import {
	identifier,
	jsonBoundary,
} from "../../../lina-core/src/world/life-json.ts";
import { fields } from "../../../lina-core/src/world/validation.ts";
import type { ImageReferenceBytes } from "./contracts.ts";

type LifeOwner = Extract<ImageOwner, { kind: "life" }>;
export interface LifeImageAssetWrites {
	/** Trusted synchronous world reservation check; no caller-supplied paths or provider work. */
	beforeWrite(metadata: AttachmentMetadata, existing: boolean): void;
	/** Called after verified bytes are durable. A lost receipt leaves an adoptable same-UUID orphan. */
	retained(metadata: AttachmentMetadata): void;
}
export function lifeImageOwnerRoot(
	root: string,
	owner: LifeOwner,
	create: boolean,
): string {
	jsonBoundary(owner);
	fields(owner, ["kind", "worldId", "agentId"]);
	if (owner.kind !== "life") throw Error("LIFE artifact owner required");
	return checkedDirectory(
		join(
			root,
			"life",
			"images",
			identifier(owner.worldId),
			identifier(owner.agentId),
		),
		create,
	);
}

/** Bytes only. Original job manifests/world receipts own metadata and read/publication authority. */
export class LifeImageAssets {
	private readonly directory: string;
	constructor(
		root: string,
		owner: LifeOwner,
		private readonly writes?: LifeImageAssetWrites,
	) {
		this.directory = checkedDirectory(
			join(lifeImageOwnerRoot(root, owner, writes !== undefined), "assets"),
			writes !== undefined,
		);
	}
	importOutput(id: string, output: ImageReferenceBytes): AttachmentMetadata {
		if (!this.writes) throw Error("LIFE image assets are read-only");
		validateId(id);
		if (!isImageMime(output.mime)) throw Error("Unsupported LIFE image type");
		const bytes = new Uint8Array(output.bytes);
		const name = this.name(id, output.mime);
		if (inspectContent(name, bytes) !== output.mime)
			throw Error("LIFE image media mismatch");
		const metadata: AttachmentMetadata = {
			id,
			name,
			mime: output.mime,
			size: bytes.byteLength,
			sha256: hash(bytes),
		};
		const path = this.path(id),
			exists = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
		if (exists) {
			checkedRegular(path);
			if (hash(readRegular(path)) !== metadata.sha256)
				throw Error("LIFE image UUID content conflict");
		}
		this.writes.beforeWrite({ ...metadata }, exists);
		if (!exists) {
			// The runtime holds the owning ImageJobStore lifetime lease during imports.
			const temporary = join(
				this.directory,
				`.image-${id}-${randomUUID()}.tmp`,
			);
			try {
				writeExclusive(temporary, bytes);
				renameSync(temporary, path);
				fsyncDirectory(this.directory);
			} finally {
				removeTemporary(temporary);
			}
		}
		this.bytes(metadata);
		this.writes.retained({ ...metadata });
		return metadata;
	}
	bytes(input: AttachmentMetadata): Uint8Array {
		const metadata = metadataShape(input);
		if (
			!isImageMime(metadata.mime) ||
			metadata.name !== this.name(metadata.id, metadata.mime)
		)
			throw Error("Invalid LIFE image metadata");
		const bytes = readRegular(this.path(metadata.id));
		if (
			bytes.byteLength !== metadata.size ||
			hash(bytes) !== metadata.sha256 ||
			inspectContent(metadata.name, bytes) !== metadata.mime
		)
			throw Error("LIFE image integrity check failed");
		return bytes;
	}
	verify(metadata: AttachmentMetadata): void {
		this.bytes(metadata);
	}
	private path(id: string): string {
		validateId(id);
		checkedDirectory(this.directory, false);
		return join(this.directory, id);
	}
	private name(id: string, mime: "image/png" | "image/jpeg"): string {
		return `life-image-${id}.${mime === "image/png" ? "png" : "jpg"}`;
	}
}
