import type { LifeConfig } from "./authoring-types.ts";
import { parseLifeConfigInput } from "./authoring-validation.ts";
import {
	type ImageAccountingBinding,
	type ImageArchiveRecord,
	type ImageByteReceipt,
	type ImageCountRecord,
	type ImageOutputReceipt,
	type ImageReservationInput,
	type ImageSettlement,
	type ImageStorageRecord,
	MAX_IMAGE_ACCOUNTING_METADATA_BYTES,
	MAX_IMAGE_OUTPUT_BYTES,
} from "./image-accounting-types.ts";
import type { LifeImageSettings } from "./image-types.ts";
import { parseLifeImageSettings } from "./image-validation.ts";
import {
	canonicalLifeJson,
	digest,
	enumeration,
	flag,
	identifier,
	jsonBoundary,
	revision,
} from "./life-json.ts";
import { fields, integer } from "./validation.ts";

export function parseImageBinding(value: unknown): ImageAccountingBinding {
	jsonBoundary(value);
	fields(value, [
		"worldId",
		"agentId",
		"intentId",
		"attemptId",
		"jobId",
		"kind",
		"sourceLifeRevision",
		"settingsRevision",
		"configRevision",
		"frozenDigest",
	]);
	return {
		worldId: identifier(value.worldId),
		agentId: identifier(value.agentId),
		intentId: identifier(value.intentId),
		attemptId: identifier(value.attemptId),
		jobId: uuid(value.jobId),
		kind: enumeration(value.kind, ["event", "avatar"]),
		sourceLifeRevision: revision(value.sourceLifeRevision),
		settingsRevision: revision(value.settingsRevision, 1),
		configRevision: revision(value.configRevision, 1),
		frozenDigest: digest(value.frozenDigest),
	};
}
function uuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
			value,
		)
	)
		throw Error("Invalid image UUID");
	return value;
}
export function parseImageReservation(value: unknown): ImageReservationInput {
	jsonBoundary(value);
	fields(value, ["binding", "outputBytes", "metadataBytes", "manifestBytes"]);
	integer(value.outputBytes, "image output bound", 1, MAX_IMAGE_OUTPUT_BYTES);
	integer(
		value.metadataBytes,
		"image metadata bound",
		1,
		MAX_IMAGE_ACCOUNTING_METADATA_BYTES,
	);
	integer(
		value.manifestBytes,
		"image manifest bound",
		1,
		MAX_IMAGE_ACCOUNTING_METADATA_BYTES,
	);
	return {
		binding: parseImageBinding(value.binding),
		outputBytes: value.outputBytes,
		metadataBytes: value.metadataBytes,
		manifestBytes: value.manifestBytes,
	};
}
export function parseImageSettlement(value: unknown): ImageSettlement {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "result"
	) {
		fields(value, ["kind", "resultFilename"]);
		return { kind: "result", resultFilename: filename(value.resultFilename) };
	}
	fields(value, ["kind"]);
	return { kind: enumeration(value.kind, ["no_post", "unknown", "failed"]) };
}
function filename(value: unknown): string {
	// Match the existing image owner's safe PNG/JPEG filename contract without a core -> runtime import.
	if (
		typeof value !== "string" ||
		value.length < 5 ||
		Buffer.byteLength(value, "utf8") > 255 ||
		value.startsWith(".") ||
		!/\.(?:png|jpe?g)$/i.test(value) ||
		/[\\/%?#:]/u.test(value) ||
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
		})
	)
		throw Error("Invalid image result filename");
	return value;
}
export function parseImageBytes(value: unknown): ImageByteReceipt {
	jsonBoundary(value);
	fields(value, ["sha256", "size"]);
	return { sha256: digest(value.sha256), size: revision(value.size, 1) };
}
export function parseImageOutput(value: unknown): ImageOutputReceipt {
	jsonBoundary(value);
	fields(value, ["id", "sha256", "size", "mime"]);
	integer(value.size, "image output size", 1, MAX_IMAGE_OUTPUT_BYTES);
	return {
		id: uuid(value.id),
		sha256: digest(value.sha256),
		size: value.size,
		mime: enumeration(value.mime, ["image/png", "image/jpeg"]),
	};
}
export function parseImageCount(value: unknown): ImageCountRecord {
	jsonBoundary(value);
	fields(value, [
		"version",
		"reservation",
		"createdAtMs",
		"archived",
		"dispatchAtMs",
		"state",
		"terminal",
		"resultFilename",
	]);
	if (value.version !== 1) throw Error("Unsupported image count version");
	const result: ImageCountRecord = {
		version: 1,
		reservation: parseImageReservation(value.reservation),
		createdAtMs: revision(value.createdAtMs),
		archived: flag(value.archived),
		dispatchAtMs:
			value.dispatchAtMs === null ? null : revision(value.dispatchAtMs),
		state: enumeration(value.state, [
			"prepared",
			"unknown",
			"attempted",
			"released",
		]),
		terminal:
			value.terminal === null
				? null
				: enumeration(value.terminal, ["no_post", "failed", "result"]),
		resultFilename:
			value.resultFilename === null ? null : filename(value.resultFilename),
	};
	const unmarked = result.dispatchAtMs === null;
	if (
		(result.archived && result.terminal === null) ||
		unmarked !== (result.state === "prepared" || result.state === "released") ||
		(!unmarked && (result.dispatchAtMs ?? 0) < result.createdAtMs) ||
		(result.state === "released"
			? result.terminal !== "no_post"
			: result.state === "attempted"
				? result.terminal !== "failed" && result.terminal !== "result"
				: result.terminal !== null) ||
		(result.terminal === "result") !== (result.resultFilename !== null)
	)
		throw Error("Corrupt image count settlement");
	return result;
}
export function parseImageStorage(value: unknown): ImageStorageRecord {
	jsonBoundary(value);
	fields(value, ["version", "outputState", "asset", "metadata", "manifest"]);
	if (value.version !== 1) throw Error("Unsupported image storage version");
	const result: ImageStorageRecord = {
		version: 1,
		outputState: enumeration(value.outputState, [
			"reserved",
			"orphan",
			"imported",
			"released",
			"abandoned",
		]),
		asset: value.asset === null ? null : parseImageOutput(value.asset),
		metadata: value.metadata === null ? null : parseImageBytes(value.metadata),
		manifest: value.manifest === null ? null : parseImageBytes(value.manifest),
	};
	if (
		(result.outputState === "imported" || result.outputState === "orphan") !==
		(result.asset !== null)
	)
		throw Error("Corrupt image output accounting");
	return result;
}
export function parseImageArchive(value: unknown): ImageArchiveRecord {
	jsonBoundary(value);
	fields(value, [
		"version",
		"count",
		"metadata",
		"manifest",
		"receipt",
		"acknowledged",
	]);
	if (value.version !== 1 || value.acknowledged !== true)
		throw Error("Invalid image archive acknowledgement");
	return {
		version: 1,
		count: parseImageCount(value.count),
		metadata: value.metadata === null ? null : parseImageBytes(value.metadata),
		manifest: parseImageBytes(value.manifest),
		receipt: parseImageBytes(value.receipt),
		acknowledged: true,
	};
}
export function validateImageRecords(
	count: ImageCountRecord,
	storage: ImageStorageRecord,
): void {
	const { binding, outputBytes, metadataBytes, manifestBytes } =
		count.reservation;
	if (
		storage.asset &&
		(storage.asset.id !== binding.jobId || storage.asset.size > outputBytes)
	)
		throw Error("Image asset identity/bound conflict");
	if (
		(count.terminal === "failed" || count.terminal === "no_post") !==
			(storage.outputState === "released") ||
		(storage.outputState !== "reserved" &&
			storage.outputState !== "released" &&
			count.terminal !== "result")
	)
		throw Error("Corrupt image storage settlement");
	const ownBytes = sumImageIntegers(
		jsonBytes(count),
		jsonBytes(storage),
		storage.metadata?.size ?? 0,
	);
	if (ownBytes > metadataBytes || (storage.manifest?.size ?? 0) > manifestBytes)
		throw Error("Image metadata bound exceeded");
}
export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(canonicalLifeJson(value));
}
export function sumImageIntegers(...values: number[]): number {
	let sum = 0;
	for (const value of values) {
		revision(value);
		sum += value;
		revision(sum);
	}
	return sum;
}
export function accountingSettings(
	value: LifeImageSettings,
	worldId: string,
	at?: number,
): LifeImageSettings {
	jsonBoundary(value);
	const { worldId: owner, revision: version, ...input } = value;
	if (owner !== worldId || (at !== undefined && version !== at))
		throw Error("Mismatched image settings history");
	return {
		...parseLifeImageSettings(input),
		worldId: identifier(owner),
		revision: revision(version, 1),
	};
}
export function accountingConfig(
	value: LifeConfig,
	worldId: string,
	at?: number,
): LifeConfig {
	jsonBoundary(value);
	const { worldId: owner, revision: version, ...input } = value;
	if (owner !== worldId || (at !== undefined && version !== at))
		throw Error("Mismatched image config history");
	return {
		...parseLifeConfigInput(input),
		worldId: identifier(owner),
		revision: revision(version, 1),
	};
}
