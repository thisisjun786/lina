import type { AttachmentMetadata } from "../../../lina-core/src/attachments/types.ts";
import type { ImageAttemptObservation } from "../../../lina-core/src/world/image-attempt-types.ts";
import type { ImageOwner } from "../../../lina-core/src/world/image-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type {
	FrozenImageReference,
	ImageArtifactPort,
	ImageCompletionPort,
	ImageJob,
	ImageReferenceBytes,
} from "./contracts.ts";
import { LifeImageAssets } from "./life-assets.ts";
import { assertLifeImageJob } from "./life-authority.ts";
import type { LifeImageAuthorityServices } from "./life-permissions.ts";

export interface LifeImagePortServices extends LifeImageAuthorityServices {
	root: string;
	owner: Extract<ImageOwner, { kind: "life" }>;
	assertLease(): void;
	resolveReference(reference: FrozenImageReference): ImageReferenceBytes;
	/** Receipts survive unavailable destinations. The runtime revisits application independently. */
	onComplete(job: ImageJob): void;
}
function outputReceipt(asset: AttachmentMetadata) {
	if (asset.mime !== "image/png" && asset.mime !== "image/jpeg")
		throw Error("Unsupported LIFE image output");
	return {
		id: asset.id,
		sha256: asset.sha256,
		mime: asset.mime,
		size: asset.size,
	};
}
function observation(job: ImageJob): ImageAttemptObservation {
	return {
		jobId: job.id,
		state: job.state,
		endpoint: job.endpoint,
		runtimeVersion: job.runtimeVersion,
		resultFilename: job.resultFilename,
		artifact: job.artifact ? outputReceipt(job.artifact) : null,
		error: job.error,
	};
}
/** Reconcile retained generation facts even if source/display permission was withdrawn. */
export function lifeImagePorts(services: LifeImagePortServices): {
	artifacts: ImageArtifactPort;
	completion: ImageCompletionPort;
	changed(job: ImageJob): void;
} {
	const { world } = services,
		worldId = services.owner.worldId;
	function changed(job: ImageJob): void {
		services.assertLease();
		const { attempt } = assertLifeImageJob(services, job);
		const next = observation(job),
			previous = attempt.observation;
		if (lifeDigest(job.owner) !== lifeDigest(services.owner))
			throw Error("Foreign LIFE artifact owner");
		if (lifeDigest(previous) !== lifeDigest(next)) {
			if (
				previous?.state === "failed" &&
				previous.resultFilename &&
				next.state === "completed"
			)
				world.recoverImageAttempt(worldId, attempt.attemptId, next);
			else world.observeImageAttempt(worldId, attempt.attemptId, next);
		}
		const count = world.imageAttemptCount(worldId, attempt.attemptId);
		if (!count) return;
		if (job.resultFilename)
			world.settleImageAttempt(worldId, attempt.attemptId, {
				kind: "result",
				resultFilename: job.resultFilename,
			});
		else if (job.state === "failed" || job.state === "cancelled")
			world.settleImageAttempt(worldId, attempt.attemptId, {
				kind: count.dispatchAtMs === null ? "no_post" : "failed",
			});
		// Reserved bounds remain charged until archive. This records the current logical record, not filesystem overhead.
		const bytes = new TextEncoder().encode(JSON.stringify(job));
		world.recordImageBytes(worldId, attempt.attemptId, "manifest", {
			sha256: lifeDigest(job),
			size: bytes.length,
		});
	}
	function assets(job: ImageJob): LifeImageAssets {
		const { attempt } = assertLifeImageJob(services, job);
		return new LifeImageAssets(services.root, services.owner, {
			beforeWrite(metadata) {
				services.assertLease();
				const count = world.imageAttemptCount(worldId, attempt.attemptId);
				if (
					!count ||
					count.terminal !== "result" ||
					metadata.id !== job.id ||
					metadata.size > count.reservation.outputBytes
				)
					throw Error("Missing original LIFE output reservation");
				world.reacquireImageOutput(worldId, attempt.attemptId);
			},
			retained(metadata) {
				world.recordImageOutput(
					worldId,
					attempt.attemptId,
					outputReceipt(metadata),
				);
			},
		});
	}
	const artifacts: ImageArtifactPort = {
		resolveReference(input) {
			if (!("origin" in input) || input.origin.kind !== "life")
				throw Error("LIFE input required");
			return input.reference
				? services.resolveReference(input.reference)
				: null;
		},
		preflight(job) {
			services.assertLease();
			const { attempt } = assertLifeImageJob(services, job);
			if (!world.imageAttemptCount(worldId, attempt.attemptId))
				throw Error("Missing LIFE reservation");
			if (job.resultFilename) {
				changed(job);
				world.reacquireImageOutput(worldId, attempt.attemptId);
			}
		},
		importOutput(job, output) {
			changed(job);
			return assets(job).importOutput(job.id, output);
		},
		verify(job) {
			assertLifeImageJob(services, job);
			if (!job.artifact) throw Error("Missing LIFE artifact");
			new LifeImageAssets(services.root, services.owner).verify(job.artifact);
		},
	};
	return {
		artifacts,
		changed,
		completion: {
			complete(job) {
				changed(job);
				services.onComplete(job);
				return {
					kind: "life",
					receiptId: `image-receipt-${lifeDigest({ origin: job.origin, observation: observation(job) })}`,
				};
			},
		},
	};
}
