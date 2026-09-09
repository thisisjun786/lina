import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type {
	AvatarAsset,
	AvatarAuthority,
	AvatarCapacityUsage,
} from "../../../lina-core/src/agents/visual.ts";
import { MAX_AVATAR_BYTES } from "../../../lina-core/src/agents/visual-validation.ts";
import {
	checkedDirectory,
	checkedRegular,
	fsyncDirectory,
	readRegular,
	removeTemporary,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import { inspectContent } from "../../../lina-core/src/attachments/validation.ts";
import type {
	FrozenImageReference,
	ImageReferenceBytes,
} from "../images/contracts.ts";

export type AvatarAssetBytes = AvatarAsset & { bytes: Uint8Array };
export type VisualReferenceBytes = AvatarAssetBytes & { assetId: string };
export type GeneratedAvatarAuthorityChecker = (
	authority: Extract<AvatarAuthority, { kind: "generated" }>,
) => boolean;

const mimeExtension = (mime: AvatarAsset["mime"]) =>
	mime === "image/png" ? "png" : "jpg";
const assetHash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Owned avatar bytes. World/job lineage remains an injected, pure authority check. */
export class AvatarAssets {
	private readonly avatars: string;
	private readonly references: string;
	constructor(
		root: string,
		private readonly agents: AgentStore,
		private readonly generatedAuthority: GeneratedAvatarAuthorityChecker,
	) {
		this.avatars = join(root, "avatars");
		this.references = join(root, "visual-references");
	}
	syncInventory(): AvatarCapacityUsage {
		const directory = checkedDirectory(this.avatars, true);
		const files = readdirSync(directory).flatMap((name) => {
			const match = /^([a-f0-9]{64})\.(png|jpg)$/.exec(name);
			if (!match) return [];
			const bytes = readRegular(join(directory, name), MAX_AVATAR_BYTES);
			const mime: AvatarAsset["mime"] =
				match[2] === "png" ? "image/png" : "image/jpeg";
			if (assetHash(bytes) !== match[1] || inspectContent(name, bytes) !== mime)
				throw Error("corrupt avatar bytes");
			return [{ fileId: name, sha256: match[1], mime, size: bytes.length }];
		});
		return this.agents.syncAvatarInventory(files);
	}
	recoverAvatarTemps(): void {
		if (!existsSync(this.avatars)) return;
		const directory = checkedDirectory(this.avatars, false);
		for (const name of readdirSync(directory)) {
			const match = /^\.avatar-([a-f0-9]{64})\.(png|jpg)\.tmp$/.exec(name);
			if (!match) continue;
			const temporary = join(directory, name);
			const mime: AvatarAsset["mime"] =
				match[2] === "png" ? "image/png" : "image/jpeg";
			const sha256 = match[1];
			if (!sha256) continue;
			const asset = { sha256, mime, size: 0 };
			const bytes = readRegular(temporary, MAX_AVATAR_BYTES);
			if (
				assetHash(bytes) !== asset.sha256 ||
				inspectContent(this.filename(asset), bytes) !== asset.mime
			)
				throw Error("corrupt interrupted avatar bytes");
			const target = join(directory, this.filename(asset));
			if (existsSync(target)) {
				const existing = readRegular(target, MAX_AVATAR_BYTES);
				if (assetHash(existing) !== asset.sha256)
					throw Error("avatar recovery conflict");
				removeTemporary(temporary);
			} else {
				renameSync(temporary, target);
				fsyncDirectory(directory);
			}
		}
	}
	importManual(
		agentId: string,
		requestKey: string,
		bytes: Uint8Array,
		filename: string,
	): AvatarAsset {
		const asset = this.asset(bytes, filename);
		const reservationId = `manual-${agentId}-${requestKey}`;
		this.syncInventory();
		const reservation = this.agents.reserveAvatarCapacity({
			reservationId,
			owner: { kind: "manual", agentId, requestKey },
			maxBytes: asset.size,
		});
		if (reservation.state === "released")
			throw Error("avatar capacity released");
		this.write(asset, bytes);
		if (reservation.state === "reserved")
			this.agents.settleAvatarCapacity(reservationId, {
				fileId: this.filename(asset),
				...asset,
			});
		return asset;
	}
	importGenerated(
		reservationId: string,
		bytes: Uint8Array,
		filename: string,
	): AvatarAsset {
		const asset = this.asset(bytes, filename);
		const reservation = this.agents.avatarCapacityReservation(reservationId);
		if (!reservation || reservation.owner.kind !== "generated")
			throw Error("generated avatar reservation denied");
		if (reservation.state === "released")
			throw Error("avatar capacity released");
		if (asset.size > reservation.maxBytes)
			throw Error("generated avatar exceeds reservation");
		if (
			reservation.state === "settled" &&
			(!reservation.asset ||
				reservation.asset.fileId !== this.filename(asset) ||
				reservation.asset.sha256 !== asset.sha256 ||
				reservation.asset.mime !== asset.mime ||
				reservation.asset.size !== asset.size)
		)
			throw Error("generated avatar settlement conflict");
		this.write(asset, bytes);
		if (reservation.state === "reserved")
			this.agents.settleAvatarCapacity(reservationId, {
				fileId: this.filename(asset),
				...asset,
			});
		return asset;
	}
	referenceAsset(bytes: Uint8Array, filename: string): AvatarAsset {
		return this.asset(bytes, filename);
	}
	writeReference(
		agentId: string,
		assetId: string,
		asset: AvatarAsset,
		bytes: Uint8Array,
	): void {
		if (!/^[a-z][a-z0-9-]{0,47}$/.test(agentId))
			throw Error("invalid reference agent");
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(assetId))
			throw Error("invalid reference asset");
		if (assetHash(bytes) !== asset.sha256 || bytes.length !== asset.size)
			throw Error("visual reference bytes conflict");
		const directory = checkedDirectory(join(this.references, agentId), true);
		const path = join(directory, `${assetId}.${mimeExtension(asset.mime)}`);
		if (existsSync(path)) {
			const existing = readRegular(path, MAX_AVATAR_BYTES);
			if (
				assetHash(existing) !== asset.sha256 ||
				existing.length !== asset.size
			)
				throw Error("visual reference storage conflict");
			return;
		}
		const temporary = join(
			directory,
			`.reference-${assetId}-${randomUUID()}.tmp`,
		);
		try {
			writeExclusive(temporary, bytes);
			renameSync(temporary, path);
			fsyncDirectory(directory);
		} finally {
			removeTemporary(temporary);
		}
	}
	recoverReferenceTemps(): void {
		if (!existsSync(this.references)) return;
		const root = checkedDirectory(this.references, false);
		for (const agentId of readdirSync(root)) {
			const directory = join(root, agentId);
			if (!/^[a-z][a-z0-9-]{0,47}$/.test(agentId) || !existsSync(directory))
				continue;
			checkedDirectory(directory, false);
			for (const name of readdirSync(directory))
				if (/^\.reference-[a-zA-Z0-9._:-]+-[a-f0-9-]+\.tmp$/.test(name))
					removeTemporary(join(directory, name));
		}
	}
	migrateCapturedLegacy(): void {
		this.syncInventory();
		for (const profile of this.agents.list()) {
			if (!profile.avatarId) continue;
			const asset = this.read(profile.avatarId);
			if (!asset) continue;
			try {
				this.agents.registerLegacyAvatar(
					profile.id,
					{ sha256: asset.sha256, mime: asset.mime, size: asset.size },
					(value) =>
						value.sha256 === asset.sha256 &&
						value.mime === asset.mime &&
						value.size === asset.size,
				);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!/source not captured/.test(error.message)
				)
					throw error;
			}
		}
	}
	migrateWorkspaceSeeds(
		workspace: string,
		presets: ReadonlyArray<{ id: string; avatarId: string | null }>,
	): void {
		const source = join(workspace, "data", "personas", "avatars");
		if (!existsSync(source)) return;
		checkedDirectory(source, false);
		for (const profile of this.agents.list()) {
			const seed = presets.find(
				(value) =>
					value.id === profile.id && value.avatarId === profile.avatarId,
			);
			if (!seed?.avatarId) continue;
			for (const mime of ["image/png", "image/jpeg"] as const) {
				const path = join(source, `${seed.avatarId}.${mimeExtension(mime)}`);
				if (!existsSync(path)) continue;
				const bytes = readRegular(path, MAX_AVATAR_BYTES);
				const asset = { sha256: seed.avatarId, mime, size: bytes.length };
				if (
					assetHash(bytes) !== asset.sha256 ||
					inspectContent(this.filename(asset), bytes) !== asset.mime
				)
					throw Error("invalid workspace avatar seed");
				this.write(asset, bytes);
				break;
			}
		}
		this.syncInventory();
		for (const profile of this.agents.list()) {
			const seed = presets.find(
				(value) =>
					value.id === profile.id && value.avatarId === profile.avatarId,
			);
			if (!seed?.avatarId) continue;
			const asset = this.read(seed.avatarId);
			if (!asset) continue;
			this.agents.registerSeedAvatar(
				profile.id,
				{ sha256: asset.sha256, mime: asset.mime, size: asset.size },
				`preset-${profile.id}-${asset.sha256}`,
				(value) =>
					value.sha256 === asset.sha256 &&
					value.mime === asset.mime &&
					value.size === asset.size,
			);
		}
	}
	readReference(
		agentId: string,
		assetId: string,
	): VisualReferenceBytes | undefined {
		if (
			!/^[a-z][a-z0-9-]{0,47}$/.test(agentId) ||
			!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(assetId) ||
			!existsSync(join(this.references, agentId))
		)
			return;
		const directory = checkedDirectory(join(this.references, agentId), false);
		for (const mime of ["image/png", "image/jpeg"] as const) {
			const path = join(directory, `${assetId}.${mimeExtension(mime)}`);
			if (!existsSync(path)) continue;
			const bytes = readRegular(path, MAX_AVATAR_BYTES);
			if (inspectContent(`${assetId}.${mimeExtension(mime)}`, bytes) !== mime)
				throw Error("corrupt visual reference bytes");
			return {
				sha256: assetHash(bytes),
				mime,
				size: bytes.length,
				assetId,
				bytes,
			};
		}
	}
	/** Resolves only a registered immutable AgentStore reference; never a caller path. */
	resolveReference(reference: FrozenImageReference): ImageReferenceBytes {
		if (reference.owner.kind !== "agent")
			throw Error("agent visual reference required");
		const stored = this.agents.visualReference(
			reference.owner.agentId,
			reference.referenceId,
		);
		if (
			!stored ||
			!isDeepStrictEqual(
				{
					owner: { kind: "agent", agentId: stored.agentId },
					referenceId: stored.id,
					assetId: stored.assetId,
					sha256: stored.sha256,
					mime: stored.mime,
					size: stored.size,
				},
				reference,
			)
		)
			throw Error("visual reference metadata conflict");
		const bytes = this.readReference(stored.agentId, stored.assetId);
		if (
			!bytes ||
			bytes.sha256 !== stored.sha256 ||
			bytes.mime !== stored.mime ||
			bytes.size !== stored.size
		)
			throw Error("visual reference bytes unavailable");
		return { bytes: bytes.bytes, mime: bytes.mime };
	}
	read(sha256: string): AvatarAssetBytes | undefined {
		if (!/^[a-f0-9]{64}$/.test(sha256) || !existsSync(this.avatars)) return;
		checkedDirectory(this.avatars, false);
		for (const mime of ["image/png", "image/jpeg"] as const) {
			const asset: AvatarAsset = {
				sha256,
				mime,
				size: 0,
			};
			const path = join(this.avatars, this.filename(asset));
			if (!existsSync(path)) continue;
			checkedRegular(path);
			const bytes = readRegular(path, MAX_AVATAR_BYTES);
			if (
				assetHash(bytes) !== sha256 ||
				inspectContent(this.filename(asset), bytes) !== mime
			)
				throw Error("corrupt avatar bytes");
			return { ...asset, size: bytes.length, bytes };
		}
	}
	globalAuthority(sha256: string): boolean {
		const asset = this.read(sha256);
		if (!asset) return false;
		return this.agents.avatarAuthorities(sha256).some((authority) => {
			if (authority.kind === "generated")
				return (
					authority.candidate.avatar.sha256 === sha256 &&
					authority.candidate.avatar.size === asset.size &&
					authority.candidate.avatar.mime === asset.mime &&
					authority.candidate.artifact.mime === asset.mime &&
					this.agents.avatarCandidateAllowed(
						authority.candidate,
						"destination",
					) &&
					this.generatedAuthority(authority)
				);
			return (
				authority.asset.sha256 === sha256 &&
				authority.asset.size === asset.size &&
				authority.asset.mime === asset.mime
			);
		});
	}
	private asset(bytes: Uint8Array, filename: string): AvatarAsset {
		const mime = inspectContent(filename, bytes);
		if (mime !== "image/png" && mime !== "image/jpeg")
			throw Error("avatar must be PNG or JPEG");
		return { sha256: assetHash(bytes), mime, size: bytes.length };
	}
	private filename(asset: Pick<AvatarAsset, "sha256" | "mime">): string {
		return `${asset.sha256}.${mimeExtension(asset.mime)}`;
	}
	private write(asset: AvatarAsset, bytes: Uint8Array): void {
		const directory = checkedDirectory(this.avatars, true);
		const path = join(directory, this.filename(asset));
		if (!existsSync(path)) {
			const temporary = join(
				directory,
				`.avatar-${asset.sha256}.${mimeExtension(asset.mime)}.tmp`,
			);
			try {
				writeExclusive(temporary, bytes);
				renameSync(temporary, path);
				fsyncDirectory(directory);
			} finally {
				removeTemporary(temporary);
			}
		} else {
			const existing = readRegular(path, MAX_AVATAR_BYTES);
			if (
				assetHash(existing) !== asset.sha256 ||
				existing.length !== asset.size
			)
				throw Error("avatar hash storage conflict");
		}
	}
}
