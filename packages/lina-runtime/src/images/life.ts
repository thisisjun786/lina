import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { AvatarAdmission } from "../../../lina-core/src/agents/visual.ts";
import { acquireImageLease } from "../../../lina-core/src/session-binding.ts";
import { MAX_IMAGE_OUTPUT_BYTES } from "../../../lina-core/src/world/image-accounting-types.ts";
import type { LifeImageAttempt } from "../../../lina-core/src/world/image-attempt-types.ts";
import type { LifeImageIntent } from "../../../lina-core/src/world/image-types.ts";
import type {
	FrozenImageReference,
	ImageJob,
	ImageReferenceBytes,
	ImageStoreLimits,
} from "./contracts.ts";
import { type ImageClient, ImageJobs } from "./jobs.ts";
import { lifeImageOwnerRoot } from "./life-assets.ts";
import {
	assertLifeImageJob,
	createLifeImageAuthority,
	lifeAvatarReservationId,
	lifeImageJobInput,
} from "./life-authority.ts";
import {
	assertLifeImageHistory,
	type LifeImageAuthorityServices,
} from "./life-permissions.ts";
import { lifeImagePorts } from "./life-ports.ts";
import { ImageJobStore } from "./store.ts";

export interface LifeImagesOptions extends LifeImageAuthorityServices {
	root: string;
	assertInstallation(): void;
	foreground(): boolean;
	createClient(): ImageClient;
	resolveReference(reference: FrozenImageReference): ImageReferenceBytes;
	syncAvatarInventory(): unknown;
	onComplete(job: ImageJob): void;
}
type OwnerHandle = {
	store: ImageJobStore;
	jobs: ImageJobs;
	close(): Promise<void>;
	assert(): void;
};
// Serialization ceilings reserve maximum growth, not a default generation allowance.
const IMAGE_METADATA_BYTES = 64 * 1024;
const IMAGE_MANIFEST_BYTES = 64 * 1024;

/** One installation manages lifetime-leased world/agent manifests; ordinary sessions are never opened. */
export class LifeImages {
	private readonly handles = new Map<string, OwnerHandle>();
	private closed = false;
	private closing: Promise<void> | null = null;
	constructor(private readonly options: LifeImagesOptions) {}
	private assertRunnable(): void {
		this.options.assertInstallation();
		if (this.closed || this.closing) throw Error("LIFE images are closed");
	}
	private limits(worldId: string): ImageStoreLimits {
		const settings = this.options.world.imageSettings(worldId);
		if (!settings) throw Error("Image settings are not configured");
		const { maxActiveJobs, maxArchivedJobs, maxTotalBytes } = settings.storage;
		return {
			maxActiveJobs,
			maxArchivedJobs,
			maxActiveBytes: maxTotalBytes,
			maxArchiveBytes: maxTotalBytes,
			maxTotalBytes,
		};
	}
	private original(worldId: string, attemptId: string) {
		const attempt = this.options.world.imageAttempt(worldId, attemptId);
		if (!attempt) throw Error("Unknown LIFE image attempt");
		const intent = assertLifeImageHistory(
			this.options,
			worldId,
			attempt.intentId,
		);
		return { attempt, intent };
	}
	/** No client, directories or leases are created by cold reads. */
	read(worldId: string, attemptId: string): ImageJob {
		const { intent, attempt } = this.original(worldId, attemptId);
		if (!attempt.jobId) throw Error("Image attempt is not linked");
		const root = lifeImageOwnerRoot(this.options.root, intent.owner, false);
		const job = ImageJobStore.openExisting(
			root,
			intent.owner,
			this.limits(worldId),
		).get(attempt.jobId);
		assertLifeImageJob(this.options, job);
		return job;
	}
	private owner(
		intent: LifeImageIntent,
		attempt: LifeImageAttempt,
	): OwnerHandle {
		if (this.closed || this.closing) throw Error("LIFE images are closed");
		this.options.assertInstallation();
		const key = JSON.stringify(intent.owner),
			prior = this.handles.get(key);
		if (prior) return prior;
		const root = lifeImageOwnerRoot(
			this.options.root,
			intent.owner,
			attempt.jobId === null,
		);
		const lease = acquireImageLease(
			root,
			intent.owner.worldId,
			intent.owner.agentId,
		);
		let active = true;
		const assert = () => {
			if (!active || this.closed) throw Error("Image manifest lease is closed");
			this.options.assertInstallation();
		};
		try {
			const exists = lstatSync(join(root, "images", "jobs.json"), {
				throwIfNoEntry: false,
			});
			if (attempt.jobId && !exists)
				throw Error("Missing original image manifest");
			const store = exists
				? ImageJobStore.openExisting(
						root,
						intent.owner,
						this.limits(intent.owner.worldId),
					)
				: new ImageJobStore(
						root,
						intent.owner,
						this.limits(intent.owner.worldId),
					);
			const ports = lifeImagePorts({
				...this.options,
				owner: intent.owner,
				assertLease: assert,
			});
			const jobs = new ImageJobs({
				store,
				client: this.options.createClient(),
				...ports,
				onChange: (job) => {
					if (job.origin.kind !== "life") throw Error("Foreign image origin");
					const linked = this.options.world.imageAttempt(
						intent.owner.worldId,
						job.origin.attemptId,
					);
					// prepare emits only after the manifest is durable and before its world UUID linkage.
					if (linked?.jobId) ports.changed(job);
				},
			});
			const handle: OwnerHandle = {
				store,
				jobs,
				assert,
				close: async () => {
					try {
						await jobs.close();
					} finally {
						active = false;
						lease.close();
					}
				},
			};
			this.handles.set(key, handle);
			return handle;
		} catch (error) {
			active = false;
			lease.close();
			throw error;
		}
	}
	private reserveAvatar(
		intent: LifeImageIntent,
		attempt: LifeImageAttempt,
	): void {
		if (intent.source.kind === "event_post") return;
		const frozen = intent.material.visuals[0];
		if (!frozen) throw Error("Missing original avatar subject");
		const admission: AvatarAdmission = {
			agentId: intent.owner.agentId,
			worldId: intent.owner.worldId,
			intentId: intent.intentId,
			materialDigest: intent.material.digest,
			resolvedPolicyId: intent.source.resolvedPolicyId,
			profileRevision: frozen.profileRevision,
			visualRevision: frozen.visualRevision,
			avatarPolicyRevision: frozen.avatarPolicyRevision,
			source: intent.source,
			grants: frozen.grants,
		};
		this.options.agents.admitAvatarIntent(intent.owner.agentId, admission);
		this.options.syncAvatarInventory();
		this.options.agents.reserveAvatarCapacity({
			reservationId: lifeAvatarReservationId(
				intent.owner.worldId,
				attempt.attemptId,
			),
			owner: {
				kind: "generated",
				agentId: intent.owner.agentId,
				worldId: intent.owner.worldId,
				intentId: intent.intentId,
				attemptId: attempt.attemptId,
			},
			maxBytes: MAX_IMAGE_OUTPUT_BYTES,
		});
	}
	/** Only a durable terminal no-result world receipt may release generation capacity. */
	private releaseAvatarWithoutResult(
		intent: LifeImageIntent,
		attempt: LifeImageAttempt,
		job: ImageJob,
	): void {
		if (
			intent.source.kind === "event_post" ||
			(job.state !== "failed" && job.state !== "cancelled") ||
			job.resultFilename ||
			job.artifact
		)
			return;
		const current = this.options.world.imageAttempt(
			intent.owner.worldId,
			attempt.attemptId,
		);
		const count = this.options.world.imageAttemptCount(
			intent.owner.worldId,
			attempt.attemptId,
		);
		if (
			!current ||
			current.jobId !== job.id ||
			!current.observation ||
			current.observation.state !== job.state ||
			current.observation.resultFilename !== null ||
			current.observation.artifact !== null ||
			!count ||
			!["no_post", "failed"].includes(count.terminal ?? "")
		)
			return;
		const reservationId = lifeAvatarReservationId(
			intent.owner.worldId,
			attempt.attemptId,
		);
		const reservation =
			this.options.agents.avatarCapacityReservation(reservationId);
		if (
			reservation?.state !== "reserved" ||
			reservation.owner.kind !== "generated" ||
			reservation.owner.agentId !== intent.owner.agentId ||
			reservation.owner.worldId !== intent.owner.worldId ||
			reservation.owner.intentId !== intent.intentId ||
			reservation.owner.attemptId !== attempt.attemptId
		)
			return;
		this.options.agents.releaseAvatarCapacity(reservationId);
	}
	async run(
		worldId: string,
		intentId: string,
		requestKey: string,
		invocation: "manual" | "scheduled",
		signal: AbortSignal,
	): Promise<ImageJob> {
		signal.throwIfAborted();
		this.assertRunnable();
		const attempt = this.options.world.prepareImageAttempt(
			worldId,
			intentId,
			requestKey,
		);
		return this.execute(worldId, attempt, invocation, signal);
	}
	async retry(
		worldId: string,
		intentId: string,
		previousAttemptId: string,
		requestKey: string,
		signal: AbortSignal,
	): Promise<ImageJob> {
		signal.throwIfAborted();
		this.assertRunnable();
		const attempt = this.options.world.retryImageAttempt(
			worldId,
			intentId,
			previousAttemptId,
			requestKey,
		);
		return this.execute(worldId, attempt, "manual", signal);
	}
	async resume(
		worldId: string,
		attemptId: string,
		invocation: "manual" | "scheduled",
		signal: AbortSignal,
	): Promise<ImageJob> {
		signal.throwIfAborted();
		const { attempt, intent } = this.original(worldId, attemptId);
		const state = attempt.observation?.state ?? "prepared";
		if (state !== "prepared") return this.reconcile(worldId, attemptId, signal);
		if (invocation === "scheduled" && intent.requestKey !== null)
			throw Error("Scheduled resume cannot submit a manual LIFE image");
		return this.execute(worldId, attempt, invocation, signal);
	}
	private async execute(
		worldId: string,
		attempt: LifeImageAttempt,
		invocation: "manual" | "scheduled",
		signal: AbortSignal,
	): Promise<ImageJob> {
		signal.throwIfAborted();
		const intent = assertLifeImageHistory(
			this.options,
			worldId,
			attempt.intentId,
		);
		const handle = this.owner(intent, attempt);
		const job = attempt.jobId
			? handle.jobs.get(attempt.jobId)
			: handle.jobs.prepare(lifeImageJobInput(intent, attempt));
		this.options.world.linkImageAttempt(worldId, attempt.attemptId, job.id);
		assertLifeImageJob(this.options, job);
		if (job.state !== "prepared")
			return this.reconcile(worldId, attempt.attemptId, signal);
		this.options.world.reserveImageAttempt(worldId, attempt.attemptId, {
			outputBytes: MAX_IMAGE_OUTPUT_BYTES,
			metadataBytes: IMAGE_METADATA_BYTES,
			manifestBytes: IMAGE_MANIFEST_BYTES,
		});
		try {
			this.reserveAvatar(intent, attempt);
		} catch (error) {
			await handle.jobs.cancel(job.id);
			throw error;
		}
		const authority = createLifeImageAuthority(
			{ ...this.options, invocation, assertLease: handle.assert },
			worldId,
			attempt.attemptId,
		);
		const result = await handle.jobs.startPrepared(job.id, authority, signal);
		await handle.jobs.flushNotices();
		const current = handle.jobs.get(result.id);
		this.releaseAvatarWithoutResult(intent, attempt, current);
		return current;
	}
	async reconcile(
		worldId: string,
		attemptId: string,
		signal?: AbortSignal,
	): Promise<ImageJob> {
		signal?.throwIfAborted();
		const { intent, attempt } = this.original(worldId, attemptId);
		if (!attempt.jobId) throw Error("Image attempt is not linked");
		const handle = this.owner(intent, attempt);
		const job = handle.jobs.get(attempt.jobId);
		assertLifeImageJob(this.options, job);
		const result =
			job.state === "failed" && job.resultFilename
				? handle.jobs.recoverArtifact(job.id, signal)
				: handle.jobs.reconcile(job.id, signal);
		return result.then((current) => {
			this.releaseAvatarWithoutResult(intent, attempt, current);
			return current;
		});
	}
	async cancel(worldId: string, attemptId: string): Promise<ImageJob> {
		const { intent, attempt } = this.original(worldId, attemptId);
		if (!attempt.jobId) throw Error("Image attempt is not linked");
		const job = await this.owner(intent, attempt).jobs.cancel(attempt.jobId);
		this.releaseAvatarWithoutResult(intent, attempt, job);
		return job;
	}
	/** Archive only a terminal LIFE receipt after core verifies its original observation and current capacity. */
	archive(worldId: string, attemptId: string) {
		this.assertRunnable();
		const { intent, attempt } = this.original(worldId, attemptId);
		if (!attempt.jobId) throw Error("Image attempt is not linked");
		const handle = this.owner(intent, attempt);
		const job = handle.jobs.get(attempt.jobId);
		assertLifeImageJob(this.options, job);
		if (job.delivery.kind !== "life")
			throw Error("LIFE archive requires its terminal completion receipt");
		const prospective = handle.store.prepareArchiveReceipt(job.id);
		this.options.world.guardArchiveImageAttempt(
			worldId,
			attemptId,
			prospective,
		);
		handle.store.archive(job.id);
		const receipt = handle.store.archiveReceipt(job.id);
		return this.options.world.archiveImageAttempt(worldId, attemptId, receipt);
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		// Reject admissions synchronously; existing callbacks retain authority until their jobs drain.
		this.closing = Promise.resolve().then(async () => {
			const results = await Promise.allSettled(
				[...this.handles.values()].map((handle) => handle.close()),
			);
			this.handles.clear();
			this.closed = true;
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		});
		return this.closing;
	}
}
