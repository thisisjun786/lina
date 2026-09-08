import type {
	AvatarApplicationReceipt,
	AvatarApplyInput,
	GeneratedAvatarCandidate,
} from "../../../lina-core/src/agents/visual.ts";
import { avatarAutomaticRequestKey } from "../../../lina-core/src/agents/visual-validation.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { AvatarAssets } from "../fleet/avatar-assets.ts";
import type { ImageJob } from "./contracts.ts";
import { LifeImageAssets } from "./life-assets.ts";
import {
	assertLifeImageJob,
	lifeAvatarReservationId,
} from "./life-authority.ts";
import {
	assertLifeImageAuthority,
	type LifeImageAuthorityServices,
} from "./life-permissions.ts";

type Applied = { status: "applied"; receipt: AvatarApplicationReceipt };
type Candidate = { status: "candidate"; candidateId: string };
export interface LifeImageDestinationOptions
	extends LifeImageAuthorityServices {
	root: string;
	avatars: AvatarAssets;
	/** Existing manifest owner, cold and storage-only when the writer is not running. */
	read(worldId: string, attemptId: string): ImageJob;
}
/** Byte verification and current cross-store authority precede every application. */
export class LifeImageDestinations {
	constructor(private readonly options: LifeImageDestinationOptions) {}
	allowed(candidate: GeneratedAvatarCandidate): boolean {
		try {
			const job = this.options.read(candidate.worldId, candidate.attemptId);
			const { intent, attempt } = assertLifeImageJob(this.options, job);
			assertLifeImageAuthority(
				this.options,
				candidate.worldId,
				candidate.intentId,
				"destination",
			);
			if (
				intent.intentId !== candidate.intentId ||
				attempt.jobId !== candidate.providerGenerationId ||
				!job.artifact ||
				job.artifact.id !== candidate.artifact.id ||
				job.artifact.sha256 !== candidate.artifact.sha256 ||
				job.artifact.mime !== candidate.artifact.mime ||
				job.artifact.size !== candidate.artifact.size ||
				candidate.avatar.sha256 !== candidate.artifact.sha256 ||
				candidate.avatar.mime !== candidate.artifact.mime ||
				candidate.avatar.size !== candidate.artifact.size
			)
				return false;
			new LifeImageAssets(this.options.root, intent.owner).verify(job.artifact);
			const avatar = this.options.avatars.read(candidate.avatar.sha256);
			return (
				!!avatar &&
				avatar.mime === candidate.avatar.mime &&
				avatar.size === candidate.avatar.size
			);
		} catch {
			return false;
		}
	}
	avatar(
		job: ImageJob,
		invocation: "automatic" | "candidate",
		apply?: AvatarApplyInput,
	): Applied | Candidate {
		const { intent, attempt } = assertLifeImageJob(this.options, job);
		if (
			intent.source.kind === "event_post" ||
			job.state !== "completed" ||
			!job.artifact
		)
			throw Error("Completed avatar result required");
		const agentId = intent.owner.agentId,
			worldId = intent.owner.worldId,
			{ agents, world } = this.options;
		const admission = agents.avatarAdmission(agentId, intent.intentId);
		if (!admission) throw Error("Missing original avatar admission");
		const candidateId = `avatar-candidate-${lifeDigest({ worldId, attemptId: attempt.attemptId })}`;
		let candidate = agents.avatarCandidate(agentId, candidateId);
		if (!candidate) {
			assertLifeImageAuthority(
				this.options,
				worldId,
				intent.intentId,
				"destination",
			);
			const bytes = new LifeImageAssets(this.options.root, intent.owner).bytes(
				job.artifact,
			);
			const avatar = this.options.avatars.importGenerated(
				lifeAvatarReservationId(worldId, attempt.attemptId),
				bytes,
				job.artifact.name,
			);
			if (
				job.artifact.mime !== "image/png" &&
				job.artifact.mime !== "image/jpeg"
			)
				throw Error("Invalid avatar type");
			candidate = agents.recordAvatarCandidate({
				...admission,
				version: 1,
				kind: "generated",
				candidateId,
				attemptId: attempt.attemptId,
				providerGenerationId: job.id,
				artifact: {
					id: job.artifact.id,
					sha256: job.artifact.sha256,
					size: job.artifact.size,
					mime: job.artifact.mime,
				},
				avatar,
			});
		}
		const visual = agents.visual(agentId),
			profile = agents.get(agentId);
		if (!profile) throw Error("Avatar agent unavailable");
		if (
			apply ||
			(invocation === "automatic" &&
				(attempt.delivery.kind === "avatar" ||
					(visual.avatarPolicy?.applyMode === "automatic" && !visual.pinned)))
		) {
			// Stable original CAS values preserve receipt-first replay after the image changed the profile revision.
			const input: AvatarApplyInput = apply ?? {
				requestKey: avatarAutomaticRequestKey(candidate),
				candidateId,
				expectedProfileRevision: candidate.profileRevision,
				expectedVisualRevision: candidate.visualRevision,
				mode: "automatic",
			};
			const receipt = agents.applyAvatarOnce(agentId, input, {
				kind: input.mode === "automatic" ? "automatic" : "owner",
				validateCandidate: (value) => this.allowed(value),
			});
			if (attempt.delivery.kind === "pending")
				world.acknowledgeImageDestination(
					worldId,
					attempt.attemptId,
					`avatar-delivery-${attempt.attemptId}`,
					{
						kind: "avatar",
						receiptId: lifeDigest({ agentId, requestKey: receipt.requestKey }),
						candidateId,
						applicationId: lifeDigest({
							agentId,
							requestKey: receipt.requestKey,
						}),
						avatarId: receipt.avatarId,
						profileRevision: receipt.profile.revision,
						visualRevision: receipt.visual.revision,
						artifactId: job.artifact.id,
					},
				);
			return { status: "applied", receipt };
		}
		return { status: "candidate", candidateId };
	}
}
