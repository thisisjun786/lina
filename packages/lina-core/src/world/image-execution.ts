import type { DatabaseSync } from "node:sqlite";
import type { LifeConfig } from "./authoring-types.ts";
import { ImageAccounting } from "./image-accounting.ts";
import type {
	ImageAccountingBinding,
	ImageAccountingSource,
	ImageByteReceipt,
	ImageReservationInput,
	ImageSettlement,
} from "./image-accounting-types.ts";
import type {
	ImageAttemptObservation,
	LifeImageAttempt,
} from "./image-attempt-types.ts";
import { actualSourceLifeRevision, ImageAttempts } from "./image-attempts.ts";
import type { LifeImageIntent, LifeImageSettings } from "./image-types.ts";
import { lifeDigest } from "./life-json.ts";

interface ImageExecutionSource {
	intent(worldId: string, intentId: string): LifeImageIntent | null;
	settings(worldId: string, revision?: number): LifeImageSettings | null;
	config(worldId: string, revision?: number): LifeConfig;
	allowed(worldId: string, intentId: string): boolean;
}

/** WorldStore owns every transaction. Files, agent grants and the provider handoff remain runtime-owned. */
export class ImageExecution {
	readonly attempts: ImageAttempts;
	readonly accounting: ImageAccounting;
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: ImageExecutionSource,
		clock: () => number,
	) {
		this.attempts = new ImageAttempts(
			db,
			{
				intent: (world, intent) => source.intent(world, intent),
				settings: (world, revision) => source.settings(world, revision),
				count: (world, attempt) => this.count(world, attempt),
			},
			clock,
		);
		this.accounting = new ImageAccounting(
			db,
			{
				settings: (world, revision) => source.settings(world, revision),
				config: (world, revision) => source.config(world, revision),
				verifyAttempt: (binding, phase) => this.verify(binding, phase),
			},
			clock,
		);
	}
	private required(worldId: string, attemptId: string): LifeImageAttempt {
		const attempt = this.attempts.get(worldId, attemptId);
		if (!attempt) throw Error("Unknown image attempt");
		return attempt;
	}
	binding(worldId: string, attemptId: string): ImageAccountingBinding {
		const attempt = this.required(worldId, attemptId),
			intent = this.source.intent(worldId, attempt.intentId);
		if (!intent || !attempt.jobId)
			throw Error("Image accounting requires an actual linked generation");
		return {
			worldId,
			agentId: intent.owner.agentId,
			intentId: intent.intentId,
			attemptId,
			jobId: attempt.jobId,
			kind: intent.source.kind === "event_post" ? "event" : "avatar",
			sourceLifeRevision: actualSourceLifeRevision(intent),
			settingsRevision: attempt.route.settingsRevision,
			configRevision: intent.configRevision,
			frozenDigest: attempt.briefDigest,
		};
	}
	private verify(
		binding: ImageAccountingBinding,
		phase: Parameters<ImageAccountingSource["verifyAttempt"]>[1],
	): void {
		if (
			lifeDigest(binding) !==
			lifeDigest(this.binding(binding.worldId, binding.attemptId))
		)
			throw Error("Image accounting lineage mismatch");
		if (
			(phase === "prepare" || phase === "submit") &&
			!this.source.allowed(binding.worldId, binding.intentId)
		)
			throw Error("Image source authority is no longer current");
		const observed = this.required(
			binding.worldId,
			binding.attemptId,
		).observation;
		if (
			phase === "zero" &&
			(!observed ||
				!["failed", "cancelled"].includes(observed.state) ||
				observed.endpoint !== null ||
				observed.runtimeVersion !== null ||
				observed.resultFilename !== null)
		)
			throw Error(
				"Image refund requires an owned preflight terminal observation",
			);
		if (phase === "recover" && !observed?.resultFilename)
			throw Error("Image recovery requires the original result");
		if (
			phase === "archive" &&
			(!observed ||
				!["completed", "failed", "cancelled"].includes(observed.state))
		)
			throw Error("Image archive requires a recorded terminal observation");
		if (phase === "archive" && observed?.jobId !== binding.jobId)
			throw Error("Image archive requires the original generation UUID");
	}
	private request(worldId: string, intentId: string, requestKey: string) {
		const intent = this.source.intent(worldId, intentId),
			settings = this.source.settings(worldId);
		if (!intent || !settings) throw Error("Missing image intent or route");
		return {
			owner: intent.owner,
			intentId,
			briefDigest: intent.briefDigest,
			requestKey,
			route: { ...settings.route, settingsRevision: settings.revision },
		};
	}
	prepare(worldId: string, intentId: string, requestKey: string) {
		const original = this.attempts.prepareRequest(worldId, requestKey);
		if (original) {
			if (original.intentId !== intentId)
				throw Error("Image attempt request replay conflict");
			return this.attempts.prepare(original);
		}
		return this.attempts.prepare(this.request(worldId, intentId, requestKey));
	}
	retry(
		worldId: string,
		intentId: string,
		previousAttemptId: string,
		requestKey: string,
	) {
		return this.attempts.retry({
			...this.request(worldId, intentId, requestKey),
			previousAttemptId,
		});
	}
	reserve(
		worldId: string,
		attemptId: string,
		bounds: Omit<ImageReservationInput, "binding">,
	) {
		return this.accounting.prepare({
			...bounds,
			binding: this.binding(worldId, attemptId),
		});
	}
	count(worldId: string, attemptId: string) {
		if (
			!this.db
				.prepare(
					"SELECT 1 FROM life_image_counts WHERE world_id=? AND attempt_id=?",
				)
				.get(worldId, attemptId)
		)
			return null;
		return this.accounting.get(this.binding(worldId, attemptId));
	}
	settle(worldId: string, attemptId: string, outcome: ImageSettlement) {
		const observed = this.required(worldId, attemptId).observation;
		if (
			outcome.kind === "failed" &&
			(!observed ||
				!["failed", "cancelled"].includes(observed.state) ||
				observed.resultFilename)
		)
			throw Error(
				"Image failure requires a known terminal generation without recoverable output",
			);
		if (
			outcome.kind === "result" &&
			observed?.resultFilename !== outcome.resultFilename
		)
			throw Error("Image result does not match the observed generation");
		return this.accounting.settle(this.binding(worldId, attemptId), outcome);
	}
	previewArchive(
		worldId: string,
		attemptId: string,
		receipt: ImageByteReceipt,
	) {
		return this.accounting.previewArchive(
			this.binding(worldId, attemptId),
			receipt,
			true,
		);
	}
	archive(worldId: string, attemptId: string, receipt: ImageByteReceipt) {
		return this.accounting.archive(
			this.binding(worldId, attemptId),
			receipt,
			true,
		);
	}
	observe(
		worldId: string,
		attemptId: string,
		observation: ImageAttemptObservation,
		recover = false,
	) {
		return recover
			? this.attempts.recoverArtifact(worldId, attemptId, observation)
			: this.attempts.observe(worldId, attemptId, observation);
	}
	validate(): void {
		this.attempts.validate();
		this.accounting.validate();
	}
}
