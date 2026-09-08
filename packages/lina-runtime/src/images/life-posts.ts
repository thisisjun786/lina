import type { ImageAttemptDelivery } from "../../../lina-core/src/world/image-attempt-types.ts";
import type { PostImageAsset } from "../../../lina-core/src/world/image-publication.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { ImageJob } from "./contracts.ts";
import { LifeImageAssets } from "./life-assets.ts";
import { assertLifeImageJob } from "./life-authority.ts";
import {
	assertLifeImageAuthority,
	type LifeImageAuthorityServices,
} from "./life-permissions.ts";

type Applied = {
	status: "applied";
	receipt: Extract<ImageAttemptDelivery, { kind: "post" }>;
};
type Held = { status: "held" };
export type LifeImagePostAsset = Pick<PostImageAsset, "mime" | "altText"> & {
	bytes: Uint8Array;
	etag: string;
};
export interface LifeImagePostsOptions extends LifeImageAuthorityServices {
	root: string;
	/** Fleet shares one options object with avatar destinations. Post delivery never uses avatars. */
	avatars?: unknown;
	/** Existing manifest owner, cold and storage-only when no image worker is running. */
	read(worldId: string, attemptId: string): ImageJob;
}

function sameArtifact(
	a: NonNullable<ImageJob["artifact"]>,
	b: { id: string; sha256: string; mime: string; size: number },
): boolean {
	return (
		a.id === b.id &&
		a.sha256 === b.sha256 &&
		a.mime === b.mime &&
		a.size === b.size
	);
}

/** Binds a completed event artifact to its original post and serves only current authorized bytes. */
export class LifeImagePosts {
	constructor(private readonly options: LifeImagePostsOptions) {}
	attach(job: ImageJob, invocation: "manual" | "automatic"): Applied | Held {
		const { intent, attempt } = assertLifeImageJob(this.options, job);
		if (
			intent.source.kind !== "event_post" ||
			job.state !== "completed" ||
			!job.artifact ||
			attempt.observation?.state !== "completed" ||
			!attempt.observation.artifact ||
			!sameArtifact(job.artifact, attempt.observation.artifact)
		)
			return { status: "held" };
		if (job.artifact.mime !== "image/png" && job.artifact.mime !== "image/jpeg")
			return { status: "held" };
		if (
			invocation === "automatic" &&
			this.options.world.imageSettings(intent.owner.worldId)?.attachMode !==
				"automatic"
		)
			return { status: "held" };
		assertLifeImageAuthority(
			this.options,
			intent.owner.worldId,
			intent.intentId,
			"destination",
		);
		new LifeImageAssets(this.options.root, intent.owner).verify(job.artifact);
		const receipt = this.options.world.attachImagePost({
			worldId: intent.owner.worldId,
			intentId: intent.intentId,
			attemptId: attempt.attemptId,
			postId: intent.source.publicationId,
			postRevision: intent.source.postRevision,
			requestKey: `image-post-${lifeDigest({ worldId: intent.owner.worldId, attemptId: attempt.attemptId })}`,
			artifact: {
				id: job.artifact.id,
				sha256: job.artifact.sha256,
				mime: job.artifact.mime,
				size: job.artifact.size,
			},
		});
		if (receipt.kind !== "post")
			throw Error("Image post receipt was not recorded");
		return {
			status: "applied",
			receipt,
		};
	}
	asset(
		worldId: string,
		postId: string,
		recipientId: string,
	): LifeImagePostAsset | null {
		try {
			const asset = this.options.world.imagePostAsset(
				worldId,
				postId,
				recipientId,
			);
			if (!asset) return null;
			const attempts = this.options.world
				.imageAttempts(worldId)
				.filter(
					(attempt) =>
						(attempt.delivery.kind === "post" &&
							attempt.delivery.postId === asset.postId &&
							attempt.delivery.postRevision === asset.postRevision &&
							attempt.delivery.artifactId === asset.artifactId) ||
						(attempt.observation?.state === "completed" &&
							attempt.observation.artifact !== null &&
							attempt.observation.artifact.id === asset.artifactId &&
							attempt.observation.artifact.sha256 === asset.sha256 &&
							attempt.observation.artifact.mime === asset.mime &&
							attempt.observation.artifact.size === asset.size),
				);
			if (attempts.length !== 1) return null;
			const attempt = attempts[0];
			if (!attempt) return null;
			const job = this.options.read(worldId, attempt.attemptId);
			const { intent, attempt: actual } = assertLifeImageJob(this.options, job);
			if (
				intent.source.kind !== "event_post" ||
				intent.source.publicationId !== asset.postId ||
				intent.source.postRevision !== asset.postRevision ||
				intent.source.recipientId !== recipientId ||
				actual.attemptId !== attempt.attemptId ||
				job.state !== "completed" ||
				!job.artifact ||
				!sameArtifact(job.artifact, {
					id: asset.artifactId,
					sha256: asset.sha256,
					mime: asset.mime,
					size: asset.size,
				})
			)
				return null;
			assertLifeImageAuthority(
				this.options,
				worldId,
				intent.intentId,
				"destination",
			);
			return {
				bytes: new LifeImageAssets(this.options.root, intent.owner).bytes(
					job.artifact,
				),
				mime: asset.mime,
				etag: asset.sha256,
				altText: asset.altText,
			};
		} catch {
			return null;
		}
	}
}
