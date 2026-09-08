import type { LifeImageAttempt } from "../../../lina-core/src/world/image-attempt-types.ts";
import type { LifeImageIntent } from "../../../lina-core/src/world/image-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type {
	ImageJob,
	ImageStartAuthority,
	LifeImageInput,
} from "./contracts.ts";
import {
	assertLifeImageAuthority,
	type LifeImageAuthorityServices,
} from "./life-permissions.ts";

export interface LifeImageExecutionAuthority
	extends LifeImageAuthorityServices {
	invocation: "manual" | "scheduled";
	/** The runtime holds the installation and per-owner manifest lease until all I/O drains. */
	assertLease(): void;
	foreground(): boolean;
}
export function lifeAvatarReservationId(
	worldId: string,
	attemptId: string,
): string {
	return `life-avatar-${lifeDigest({ worldId, attemptId })}`;
}
export function lifeImageJobInput(
	intent: LifeImageIntent,
	attempt: LifeImageAttempt,
): LifeImageInput {
	if (
		lifeDigest(attempt.owner) !== lifeDigest(intent.owner) ||
		attempt.intentId !== intent.intentId ||
		attempt.briefDigest !== intent.briefDigest ||
		attempt.intentDigest !== lifeDigest(intent)
	)
		throw Error("Image attempt differs from its frozen intent");
	const reference = intent.material.visuals.find(
		(visual) => visual.reference !== null,
	)?.reference;
	return {
		origin: {
			kind: "life",
			intentId: intent.intentId,
			attemptId: attempt.attemptId,
			briefDigest: intent.briefDigest,
		},
		provider: attempt.route.provider,
		model: attempt.route.model,
		prompt: intent.material.prompt,
		reference: reference
			? {
					owner: { kind: "agent", agentId: reference.agentId },
					referenceId: reference.id,
					assetId: reference.assetId,
					sha256: reference.sha256,
					mime: reference.mime,
					size: reference.size,
				}
			: null,
	};
}
export function assertLifeImageJob(
	services: LifeImageAuthorityServices,
	job: ImageJob,
) {
	if (job.owner.kind !== "life" || job.origin.kind !== "life")
		throw Error("LIFE image owner required");
	const worldId = job.owner.worldId,
		attempt = services.world.imageAttempt(worldId, job.origin.attemptId);
	const intent = services.world.imageIntent(worldId, job.origin.intentId);
	if (
		!attempt ||
		!intent ||
		attempt.jobId !== job.id ||
		lifeDigest(job.owner) !== lifeDigest(intent.owner)
	)
		throw Error("Image manifest differs from world UUID ownership");
	const expected = lifeImageJobInput(intent, attempt);
	if (
		lifeDigest(expected) !==
		lifeDigest({
			origin: job.origin,
			provider: job.provider,
			model: job.model,
			prompt: job.prompt,
			reference: job.reference,
		})
	)
		throw Error("Image manifest differs from frozen material");
	return { intent, attempt };
}
/** Passed only by the trusted runtime. It performs no awaits or provider work. */
export function createLifeImageAuthority(
	services: LifeImageExecutionAuthority,
	worldId: string,
	attemptId: string,
): ImageStartAuthority {
	return {
		beforeSubmit(job, snapshot) {
			services.assertLease();
			if (services.foreground()) throw Error("Foreground work has priority");
			const { intent, attempt } = assertLifeImageJob(services, job);
			if (intent.owner.worldId !== worldId || attempt.attemptId !== attemptId)
				throw Error("Foreign image dispatch");
			assertLifeImageAuthority(services, worldId, intent.intentId, "provider");
			if (services.invocation !== "manual") {
				const config = services.world.lifeConfig(worldId);
				const mode =
					intent.source.kind === "event_post"
						? config.images?.mode
						: config.avatars?.mode;
				if (services.invocation !== "scheduled" || mode !== "automatic")
					throw Error("Automatic image execution is not enabled");
			}
			if (
				snapshot.body.requestId !== job.id ||
				snapshot.body.prompt !== intent.material.prompt ||
				snapshot.body.provider !== attempt.route.provider ||
				snapshot.body.model !== attempt.route.model
			)
				throw Error("Image POST differs from its frozen attempt");
			if (intent.source.kind !== "event_post") {
				const visual = services.agents.visual(intent.owner.agentId);
				if (
					services.invocation === "scheduled" &&
					visual.pinned &&
					visual.avatarPolicy?.whilePinned === "skip"
				)
					throw Error("Pinned avatar generation is disabled");
				const reservation = services.agents.avatarCapacityReservation(
					lifeAvatarReservationId(worldId, attemptId),
				);
				const admission = services.agents.avatarAdmission(
					intent.owner.agentId,
					intent.intentId,
				);
				const count = services.world.imageAttemptCount(worldId, attemptId);
				if (
					!reservation ||
					reservation.state !== "reserved" ||
					reservation.owner.kind !== "generated" ||
					reservation.owner.worldId !== worldId ||
					reservation.owner.agentId !== intent.owner.agentId ||
					reservation.owner.intentId !== intent.intentId ||
					reservation.owner.attemptId !== attemptId ||
					!count ||
					reservation.maxBytes < count.reservation.outputBytes ||
					!admission ||
					admission.materialDigest !== intent.material.digest
				)
					throw Error("Missing original avatar destination reservation");
			}
			services.world.dispatchImageAttempt(worldId, attemptId);
			return undefined;
		},
	};
}
