import type { DatabaseSync } from "node:sqlite";
import type {
	ImageCountRecord,
	ImageOutputReceipt,
} from "./image-accounting-types.ts";
import { parseImageOutput } from "./image-accounting-validation.ts";
import type {
	ImageAttemptDelivery,
	LifeImageAttempt,
} from "./image-attempt-types.ts";
import type { LifeImageIntent, PublishedImageMaterial } from "./image-types.ts";
import {
	canonicalLifeJson,
	digest,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { EventPublicationPost } from "./publication-types.ts";
import { fields } from "./validation.ts";

/** Schema8 extension. WorldStore composes this DDL into its migration transaction. */
export const IMAGE_PUBLICATION_SCHEMA = `
CREATE TABLE life_image_post_associations (
 world_id TEXT NOT NULL REFERENCES worlds(id), association_id TEXT NOT NULL,
 intent_id TEXT NOT NULL, attempt_id TEXT NOT NULL, post_id TEXT NOT NULL,
 post_revision INTEGER NOT NULL CHECK(post_revision>0), author_agent_id TEXT NOT NULL,
 recipient_id TEXT NOT NULL, publication_material_id TEXT NOT NULL,
 publication_material_digest TEXT NOT NULL, job_id TEXT NOT NULL,
 artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)), artifact_digest TEXT NOT NULL,
 alt_text TEXT NOT NULL, attachment_version INTEGER NOT NULL CHECK(attachment_version>0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 digest TEXT NOT NULL, PRIMARY KEY(world_id,association_id), UNIQUE(world_id,post_id),
 UNIQUE(world_id,attempt_id)
) STRICT;
CREATE TABLE life_image_post_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL,
 association_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key), FOREIGN KEY(world_id,association_id)
 REFERENCES life_image_post_associations(world_id,association_id)
) STRICT;
CREATE INDEX life_image_post_associations_post ON life_image_post_associations(world_id,post_id,post_revision);
CREATE INDEX life_image_post_associations_artifact ON life_image_post_associations(world_id,job_id,artifact_digest);
`;

export interface ImagePostAssociationInput {
	worldId: string;
	intentId: string;
	attemptId: string;
	postId: string;
	postRevision: number;
	requestKey: string;
	/** Runtime supplies manifest-and-byte verified metadata; core compares it with the completed attempt. */
	artifact: ImageOutputReceipt;
}

export interface ImagePublicationSource {
	/** Historical, validated owners. These return records, never forgeable booleans. */
	intent(worldId: string, intentId: string): LifeImageIntent | null;
	attempt(worldId: string, attemptId: string): LifeImageAttempt | null;
	post(
		worldId: string,
		postId: string,
		revision: number,
	): EventPublicationPost | null;
	/** Current feed/material authority for the exact destination. A withdrawn or foreign post returns null. */
	currentMaterial(
		worldId: string,
		postId: string,
		authorAgentId: string,
		recipientId: string,
	): PublishedImageMaterial | null;
	/** Actual WorldStore/ImageExecution reservation; an absent or mismatched record never funds receipts. */
	count(worldId: string, attemptId: string): ImageCountRecord | null;
}

export interface PostImageAsset {
	kind: "post";
	receiptId: string;
	postId: string;
	postRevision: number;
	artifactId: string;
	sha256: string;
	mime: "image/png" | "image/jpeg";
	size: number;
	altText: string;
	attachmentVersion: number;
}

type Association = {
	version: 1;
	associationId: string;
	worldId: string;
	intentId: string;
	attemptId: string;
	postId: string;
	postRevision: number;
	authorAgentId: string;
	recipientId: string;
	publicationMaterialId: string;
	publicationMaterialDigest: string;
	jobId: string;
	artifact: ImageOutputReceipt;
	altText: string;
	attachmentVersion: number;
	createdAtMs: number;
};
type AssociationRow = {
	world_id: string;
	association_id: string;
	intent_id: string;
	attempt_id: string;
	post_id: string;
	post_revision: number;
	author_agent_id: string;
	recipient_id: string;
	publication_material_id: string;
	publication_material_digest: string;
	job_id: string;
	artifact_json: string;
	artifact_digest: string;
	alt_text: string;
	attachment_version: number;
	created_at_ms: number;
	record_json: string;
	digest: string;
};
type ReceiptRow = {
	association_id: string;
	payload_json: string;
	payload_digest: string;
};

function parseInput(value: unknown): ImagePostAssociationInput {
	jsonBoundary(value);
	fields(value, [
		"worldId",
		"intentId",
		"attemptId",
		"postId",
		"postRevision",
		"requestKey",
		"artifact",
	]);
	return {
		worldId: identifier(value.worldId),
		intentId: identifier(value.intentId),
		attemptId: identifier(value.attemptId),
		postId: identifier(value.postId),
		postRevision: revision(value.postRevision, 1),
		requestKey: identifier(value.requestKey),
		artifact: parseImageOutput(value.artifact),
	};
}

function parseAssociation(value: unknown): Association {
	jsonBoundary(value);
	fields(value, [
		"version",
		"associationId",
		"worldId",
		"intentId",
		"attemptId",
		"postId",
		"postRevision",
		"authorAgentId",
		"recipientId",
		"publicationMaterialId",
		"publicationMaterialDigest",
		"jobId",
		"artifact",
		"altText",
		"attachmentVersion",
		"createdAtMs",
	]);
	if (value.version !== 1)
		throw Error("Unsupported image post association version");
	if (typeof value.altText !== "string" || !value.altText.trim())
		throw Error("Invalid image post alternative text");
	const association: Association = {
		version: 1,
		associationId: identifier(value.associationId),
		worldId: identifier(value.worldId),
		intentId: identifier(value.intentId),
		attemptId: identifier(value.attemptId),
		postId: identifier(value.postId),
		postRevision: revision(value.postRevision, 1),
		authorAgentId: identifier(value.authorAgentId),
		recipientId: identifier(value.recipientId),
		publicationMaterialId: identifier(value.publicationMaterialId),
		publicationMaterialDigest: digest(value.publicationMaterialDigest),
		jobId: identifier(value.jobId),
		artifact: parseImageOutput(value.artifact),
		altText: value.altText,
		attachmentVersion: revision(value.attachmentVersion, 1),
		createdAtMs: revision(value.createdAtMs),
	};
	if (
		association.associationId !==
		`image-post-${lifeDigest({
			worldId: association.worldId,
			postId: association.postId,
			attemptId: association.attemptId,
		})}`
	)
		throw Error("Image post association identity mismatch");
	return association;
}

/** Durable event-post attachment owner. It persists only metadata; runtime owns files and byte verification. */
export class ImagePublication {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: ImagePublicationSource,
		private readonly clock: () => number = Date.now,
	) {}
	private association(
		worldId: string,
		associationId: string,
	): Association | null {
		const row = this.db
			.prepare(
				"SELECT world_id,association_id,intent_id,attempt_id,post_id,post_revision,author_agent_id,recipient_id,publication_material_id,publication_material_digest,job_id,artifact_json,artifact_digest,alt_text,attachment_version,created_at_ms,record_json,digest FROM life_image_post_associations WHERE world_id=? AND association_id=?",
			)
			.get(identifier(worldId), identifier(associationId)) as
			| AssociationRow
			| undefined;
		if (!row) return null;
		const association = parseAssociation(JSON.parse(row.record_json));
		if (
			association.worldId !== row.world_id ||
			association.associationId !== row.association_id ||
			association.intentId !== row.intent_id ||
			association.attemptId !== row.attempt_id ||
			association.postId !== row.post_id ||
			association.postRevision !== row.post_revision ||
			association.authorAgentId !== row.author_agent_id ||
			association.recipientId !== row.recipient_id ||
			association.publicationMaterialId !== row.publication_material_id ||
			association.publicationMaterialDigest !==
				row.publication_material_digest ||
			association.jobId !== row.job_id ||
			canonicalLifeJson(association.artifact) !== row.artifact_json ||
			lifeDigest(association.artifact) !== row.artifact_digest ||
			association.altText !== row.alt_text ||
			association.attachmentVersion !== row.attachment_version ||
			association.createdAtMs !== row.created_at_ms ||
			canonicalLifeJson(association) !== row.record_json ||
			lifeDigest(association) !== row.digest
		)
			throw Error("Corrupt image post association");
		this.historical(association);
		return association;
	}
	private byPost(worldId: string, postId: string): Association | null {
		const row = this.db
			.prepare(
				"SELECT association_id FROM life_image_post_associations WHERE world_id=? AND post_id=?",
			)
			.get(identifier(worldId), identifier(postId)) as
			| { association_id: string }
			| undefined;
		return row ? this.association(worldId, String(row.association_id)) : null;
	}
	private historical(value: Association): void {
		const intent = this.source.intent(value.worldId, value.intentId);
		const attempt = this.source.attempt(value.worldId, value.attemptId);
		const post = this.source.post(
			value.worldId,
			value.postId,
			value.postRevision,
		);
		if (!intent || !attempt || !post)
			throw Error("Missing image post provenance");
		canonicalLifeJson(intent);
		canonicalLifeJson(attempt);
		if (
			intent.version !== 2 ||
			intent.owner.worldId !== value.worldId ||
			intent.source.kind !== "event_post" ||
			intent.source.publicationId !== value.postId ||
			intent.source.postRevision !== value.postRevision ||
			intent.source.publicationMaterialId !== value.publicationMaterialId ||
			intent.source.publicationMaterialDigest !==
				value.publicationMaterialDigest ||
			intent.owner.agentId !== value.authorAgentId ||
			intent.source.recipientId !== value.recipientId ||
			intent.material.altText !== value.altText ||
			attempt.intentId !== intent.intentId ||
			attempt.attemptId !== value.attemptId ||
			attempt.jobId !== value.jobId ||
			attempt.observation?.state !== "completed" ||
			!attempt.observation.artifact ||
			lifeDigest(attempt.observation.artifact) !== lifeDigest(value.artifact) ||
			post.version !== 1 ||
			post.worldId !== value.worldId ||
			post.id !== value.postId ||
			post.revision !== value.postRevision ||
			post.withdrawn ||
			post.author.agentId !== value.authorAgentId ||
			post.material.id !== value.publicationMaterialId ||
			post.material.digest !== value.publicationMaterialDigest ||
			!post.material.audience.includes(value.recipientId)
		)
			throw Error("Image post provenance mismatch");
	}
	private current(value: Association): void {
		const material = this.source.currentMaterial(
			value.worldId,
			value.postId,
			value.authorAgentId,
			value.recipientId,
		);
		if (
			!material ||
			material.worldId !== value.worldId ||
			material.authorAgentId !== value.authorAgentId ||
			material.source.publicationId !== value.postId ||
			material.source.postRevision !== value.postRevision ||
			material.source.publicationMaterialId !== value.publicationMaterialId ||
			material.source.publicationMaterialDigest !==
				value.publicationMaterialDigest ||
			material.source.recipientId !== value.recipientId
		)
			throw Error("Image post destination is no longer permitted");
	}
	private delivery(value: Association): ImageAttemptDelivery {
		return {
			kind: "post",
			receiptId: value.associationId,
			postId: value.postId,
			postRevision: value.postRevision,
			artifactId: value.artifact.id,
		};
	}
	private capacity(
		value: Association,
		extraReceipt: ImagePostAssociationInput | null,
	): void {
		const count = this.source.count(value.worldId, value.attemptId);
		if (
			!count ||
			count.reservation.binding.worldId !== value.worldId ||
			count.reservation.binding.intentId !== value.intentId ||
			count.reservation.binding.attemptId !== value.attemptId ||
			count.reservation.binding.jobId !== value.jobId
		)
			throw Error("Missing actual image metadata reservation");
		let used =
			Buffer.byteLength(canonicalLifeJson(value)) +
			Buffer.byteLength(canonicalLifeJson(value.artifact));
		const receipts = this.db
			.prepare(
				"SELECT payload_json FROM life_image_post_receipts WHERE world_id=? AND association_id=?",
			)
			.all(value.worldId, value.associationId) as Array<{
			payload_json: string;
		}>;
		for (const receipt of receipts)
			used += Buffer.byteLength(String(receipt.payload_json));
		if (extraReceipt)
			used += Buffer.byteLength(canonicalLifeJson(extraReceipt));
		if (used > count.reservation.metadataBytes)
			throw Error("Image post metadata reservation exceeded");
	}
	record(value: ImagePostAssociationInput): ImageAttemptDelivery {
		const input = parseInput(value),
			payloadDigest = lifeDigest(input);
		const receipt = this.db
			.prepare(
				"SELECT association_id,payload_json,payload_digest FROM life_image_post_receipts WHERE world_id=? AND request_key=?",
			)
			.get(input.worldId, input.requestKey) as ReceiptRow | undefined;
		if (receipt) {
			if (
				receipt.payload_digest !== payloadDigest ||
				receipt.payload_json !== canonicalLifeJson(input)
			)
				throw Error("Image post request conflict");
			const existing = this.association(
				input.worldId,
				String(receipt.association_id),
			);
			if (!existing) throw Error("Missing image post request association");
			if (
				existing.intentId !== input.intentId ||
				existing.attemptId !== input.attemptId ||
				existing.postId !== input.postId ||
				existing.postRevision !== input.postRevision ||
				lifeDigest(existing.artifact) !== lifeDigest(input.artifact)
			)
				throw Error("Image post receipt does not describe its association");
			this.current(existing);
			return this.delivery(existing);
		}
		const existing = this.byPost(input.worldId, input.postId);
		if (existing) {
			this.current(existing);
			if (
				existing.intentId !== input.intentId ||
				existing.attemptId !== input.attemptId ||
				existing.postRevision !== input.postRevision ||
				lifeDigest(existing.artifact) !== lifeDigest(input.artifact)
			)
				throw Error("Post already has a different image association");
			this.capacity(existing, input);
			this.receipt(input, existing.associationId, payloadDigest);
			return this.delivery(existing);
		}
		const intent = this.source.intent(input.worldId, input.intentId);
		const attempt = this.source.attempt(input.worldId, input.attemptId);
		if (!intent || !attempt || intent.source.kind !== "event_post")
			throw Error("Image post association requires an event intent");
		if (!attempt.jobId)
			throw Error("Image post association requires a linked job UUID");
		const association = parseAssociation({
			version: 1,
			associationId: `image-post-${lifeDigest({ worldId: input.worldId, postId: input.postId, attemptId: input.attemptId })}`,
			worldId: input.worldId,
			intentId: input.intentId,
			attemptId: input.attemptId,
			postId: input.postId,
			postRevision: input.postRevision,
			authorAgentId: intent.owner.agentId,
			recipientId: intent.source.recipientId,
			publicationMaterialId: intent.source.publicationMaterialId,
			publicationMaterialDigest: intent.source.publicationMaterialDigest,
			jobId: attempt.jobId,
			artifact: input.artifact,
			altText: intent.material.altText,
			attachmentVersion: 1,
			createdAtMs: this.clock(),
		});
		this.historical(association);
		this.current(association);
		this.capacity(association, input);
		const json = canonicalLifeJson(association);
		this.db
			.prepare(
				"INSERT INTO life_image_post_associations(world_id,association_id,intent_id,attempt_id,post_id,post_revision,author_agent_id,recipient_id,publication_material_id,publication_material_digest,job_id,artifact_json,artifact_digest,alt_text,attachment_version,created_at_ms,record_json,digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				input.worldId,
				association.associationId,
				input.intentId,
				input.attemptId,
				input.postId,
				input.postRevision,
				association.authorAgentId,
				association.recipientId,
				association.publicationMaterialId,
				association.publicationMaterialDigest,
				association.jobId,
				canonicalLifeJson(association.artifact),
				lifeDigest(association.artifact),
				association.altText,
				1,
				association.createdAtMs,
				json,
				lifeDigest(association),
			);
		this.receipt(input, association.associationId, payloadDigest);
		return this.delivery(association);
	}
	private receipt(
		input: ImagePostAssociationInput,
		associationId: string,
		payloadDigest: string,
	): void {
		this.db
			.prepare(
				"INSERT INTO life_image_post_receipts(world_id,request_key,association_id,payload_json,payload_digest) VALUES(?,?,?,?,?)",
			)
			.run(
				input.worldId,
				input.requestKey,
				associationId,
				canonicalLifeJson(input),
				payloadDigest,
			);
	}
	/** A cold read only returns retained metadata after current destination authority succeeds. */
	asset(
		worldId: string,
		postId: string,
		recipientId: string,
	): PostImageAsset | null {
		const value = this.byPost(worldId, postId);
		if (!value) return null;
		if (value.recipientId !== identifier(recipientId))
			throw Error("Image post recipient is not permitted");
		this.current(value);
		return {
			kind: "post",
			receiptId: value.associationId,
			postId: value.postId,
			postRevision: value.postRevision,
			artifactId: value.artifact.id,
			sha256: value.artifact.sha256,
			mime: value.artifact.mime,
			size: value.artifact.size,
			altText: value.altText,
			attachmentVersion: value.attachmentVersion,
		};
	}
	validate(): void {
		const indexes = this.db
			.prepare(
				"SELECT name FROM pragma_index_list('life_image_post_associations')",
			)
			.all() as Array<{ name: string }>;
		for (const name of [
			"life_image_post_associations_post",
			"life_image_post_associations_artifact",
		])
			if (!indexes.some((index) => index.name === name))
				throw Error("Missing image post association index");
		const rows = this.db
			.prepare(
				"SELECT world_id,association_id FROM life_image_post_associations",
			)
			.all() as Array<{ world_id: string; association_id: string }>;
		for (const row of rows) {
			const association = this.association(
				String(row.world_id),
				String(row.association_id),
			);
			if (!association) throw Error("Missing image post association");
			this.capacity(association, null);
		}
		for (const row of this.db
			.prepare(
				"SELECT world_id,request_key,association_id,payload_json,payload_digest FROM life_image_post_receipts",
			)
			.all() as Array<{
			world_id: string;
			request_key: string;
			association_id: string;
			payload_json: string;
			payload_digest: string;
		}>) {
			const input = parseInput(JSON.parse(row.payload_json));
			if (
				input.worldId !== row.world_id ||
				input.requestKey !== row.request_key ||
				canonicalLifeJson(input) !== row.payload_json ||
				lifeDigest(input) !== row.payload_digest
			)
				throw Error("Corrupt image post request receipt");
			if (!this.association(String(row.world_id), String(row.association_id)))
				throw Error("Missing image post receipt association");
			const association = this.association(
				String(row.world_id),
				String(row.association_id),
			);
			if (
				!association ||
				association.intentId !== input.intentId ||
				association.attemptId !== input.attemptId ||
				association.postId !== input.postId ||
				association.postRevision !== input.postRevision ||
				lifeDigest(association.artifact) !== lifeDigest(input.artifact)
			)
				throw Error("Image post receipt does not describe its association");
		}
	}
}
