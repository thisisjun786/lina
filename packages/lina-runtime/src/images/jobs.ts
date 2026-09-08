import { setTimeout as delay } from "node:timers/promises";
import type { AttachmentStore } from "../../../lina-core/src/attachments/store.ts";
import { isImageMime } from "../../../lina-core/src/attachments/types.ts";
import type { SessionPort } from "../sdk-port.ts";
import type { Ima2Client } from "./client.ts";
import type {
	ImageArtifactPort,
	ImageCompletionPort,
	ImageReferenceBytes,
	ImageStartAuthority,
} from "./contracts.ts";
import { conversationImagePorts } from "./conversation.ts";
import { ImageJobExecution, safeError } from "./image-job-execution.ts";
import { sameImageTerminal } from "./image-store-schema.ts";
import {
	type ImageJob,
	type ImageJobInput,
	type ImageJobStore,
	terminalImageState,
} from "./store.ts";

export type ImageClient = Pick<
	Ima2Client,
	"connect" | "submit" | "read" | "cancel" | "download"
>;
type BaseOptions = {
	store: ImageJobStore;
	client: ImageClient;
	onChange?: (job: ImageJob) => void;
};
type Options = BaseOptions &
	(
		| { attachments: AttachmentStore; notify: SessionPort["appendNotice"] }
		| { artifacts: ImageArtifactPort; completion: ImageCompletionPort }
	);
/** Provider status recovery interval; this is not a LIFE scheduling cadence. */
export const IMAGE_POLL_MS = 1500;
const WAIT_MS = 5 * 60 * 1000;
export class ImageJobs {
	private readonly active = new Map<string, Promise<ImageJob>>();
	private readonly observed = new Map<string, string>();
	private readonly shutdown = new AbortController();
	private poll: Promise<void> | undefined;
	private notices: Promise<void> | undefined;
	private recoveryError: string | null = null;
	private readonly artifacts: ImageArtifactPort;
	private readonly execution: ImageJobExecution;
	private readonly completion: ImageCompletionPort;
	constructor(private readonly options: Options) {
		const ports =
			"attachments" in options
				? conversationImagePorts(
						options.store,
						options.attachments,
						options.notify,
					)
				: options;
		this.artifacts = ports.artifacts;
		this.execution = new ImageJobExecution(
			options.store,
			options.client,
			ports.artifacts,
			(signal) => this.signal(signal),
		);
		this.completion = ports.completion;
		for (const job of this.list())
			this.observed.set(job.id, this.observation(job));
	}
	get owner() {
		return structuredClone(this.options.store.owner);
	}
	list() {
		return this.options.store.list();
	}
	get(id: string) {
		return this.options.store.get(id);
	}
	async connect(signal?: AbortSignal) {
		const connection = await this.options.client.connect(signal);
		const verified = this.list()
			.filter((j) => j.state === "completed")
			.map((j) => ({
				provider: j.provider,
				model: j.model,
				version: j.runtimeVersion,
				endpoint: j.endpoint,
				completedAt: j.updatedAt,
			}));
		return {
			...connection,
			ownership: "external" as const,
			setupUrl: connection.baseUrl,
			generationVerified: verified,
			recoveryError: this.recoveryError,
		};
	}
	/** Durable creation only. Runtime links this UUID to its core attempt before startPrepared. */
	prepare(input: ImageJobInput): ImageJob {
		this.shutdown.signal.throwIfAborted();
		const previous = this.options.store.find(input);
		if (previous) return previous;
		this.assertIdle();
		return this.changed(this.options.store.create(input));
	}
	async start(raw: ImageJobInput, signal?: AbortSignal): Promise<ImageJob> {
		if (this.options.store.owner.kind === "life")
			throw Error(
				"LIFE requires prepare, UUID link and startPrepared authority",
			);
		const input = structuredClone(raw);
		this.shutdown.signal.throwIfAborted();
		signal?.throwIfAborted();
		const previous = this.options.store.find(input);
		if (previous) return previous;
		this.assertIdle();
		// Preserve pre-create rejection of references outside this conversation.
		const reference = await this.artifacts.resolveReference(input);
		const created = this.prepare(input);
		return this.runPrepared(created.id, undefined, signal, reference);
	}
	async startPrepared(
		id: string,
		authority: ImageStartAuthority,
		signal?: AbortSignal,
	): Promise<ImageJob> {
		if (this.options.store.owner.kind !== "life")
			throw Error("startPrepared is LIFE-only");
		if (!authority || typeof authority.beforeSubmit !== "function")
			throw Error("LIFE image start authority is required");
		return this.runPrepared(id, authority, signal);
	}
	private assertIdle(id?: string): void {
		if (this.list().some((j) => j.id !== id && !terminalImageState(j.state)))
			throw Error(
				"이미지 작업이 아직 끝나지 않았습니다. 기존 작업을 확인해주세요.",
			);
	}
	private runPrepared(
		id: string,
		authority?: ImageStartAuthority,
		signal?: AbortSignal,
		resolved?: ImageReferenceBytes | null,
	): Promise<ImageJob> {
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (job.state !== "prepared") return job;
			this.assertIdle(id);
			return this.changed(
				await this.execution.submit(id, authority, signal, resolved),
			);
		});
	}
	private changed(job: ImageJob): ImageJob {
		const observation = this.observation(job);
		if (this.observed.get(job.id) !== observation) {
			this.observed.set(job.id, observation);
			this.options.onChange?.(structuredClone(job));
		}
		return job;
	}
	private observation(job: ImageJob): string {
		const { updatedAt: _updatedAt, ...facts } = job;
		return JSON.stringify(facts);
	}
	async reconcile(id: string, signal?: AbortSignal): Promise<ImageJob> {
		signal?.throwIfAborted();
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (
				job.owner.kind === "life" &&
				job.state === "prepared" &&
				!job.cancelRequested
			)
				return job;
			if (terminalImageState(job.state)) {
				if (job.owner.kind === "life" && job.artifact)
					await this.artifacts.verify(job);
				await this.flushNotices();
				return this.get(id);
			}
			try {
				if (
					job.state === "prepared" ||
					(job.cancelRequested && job.endpoint === null)
				) {
					this.options.store.update(id, {
						state: job.cancelRequested ? "cancelled" : "failed",
						error:
							"생성 요청 전에 실행이 중단되었습니다. 새 요청으로 시작해주세요.",
					});
				} else {
					const connection = await this.options.client.connect(
						this.signal(signal),
					);
					if (
						connection.baseUrl !== job.endpoint ||
						connection.version !== job.runtimeVersion
					)
						throw Error("Image runtime changed");
					let result = await this.options.client.read(id, this.signal(signal));
					if (
						this.get(id).cancelRequested &&
						["queued", "running", "post_processing"].includes(result.state)
					) {
						await this.options.client.cancel(id, this.signal(signal));
						result = await this.options.client.read(id, this.signal(signal));
					}
					await this.execution.apply(id, result);
				}
			} catch (error) {
				if (!terminalImageState(this.get(id).state))
					this.options.store.update(id, {
						state: this.get(id).cancelRequested ? "cancelling" : "uncertain",
						error: safeError(error),
					});
			}
			await this.flushNotices();
			return this.changed(this.get(id));
		});
	}
	async cancel(id: string): Promise<ImageJob> {
		// Serialize the intent behind submission without coalescing it with a read.
		const current = this.get(id);
		if (terminalImageState(current.state)) return current;
		this.options.store.update(id, {
			cancelRequested: true,
			state: "cancelling",
			error: null,
		});
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (terminalImageState(job.state)) return job;
			if (job.endpoint === null) {
				this.changed(
					this.options.store.update(id, { state: "cancelled", error: null }),
				);
				await this.flushNotices();
				return this.changed(this.get(id));
			}
			try {
				const connection = await this.options.client.connect(
					this.shutdown.signal,
				);
				if (
					connection.baseUrl !== job.endpoint ||
					connection.version !== job.runtimeVersion
				)
					throw Error("Image runtime changed");
				await this.options.client.cancel(id, this.shutdown.signal);
				await this.execution.apply(
					id,
					await this.options.client.read(id, this.shutdown.signal),
				);
			} catch (error) {
				this.options.store.update(id, {
					state: "cancelling",
					error: safeError(error),
				});
			}
			await this.flushNotices();
			return this.changed(this.get(id));
		});
	}
	async wait(id: string, signal?: AbortSignal): Promise<ImageJob> {
		const deadline = Date.now() + WAIT_MS;
		while (!this.shutdown.signal.aborted) {
			if (signal?.aborted) return this.cancel(id);
			const job = await this.reconcile(id, signal);
			if (
				terminalImageState(job.state) ||
				job.state === "uncertain" ||
				Date.now() >= deadline
			)
				return job;
			try {
				await delay(IMAGE_POLL_MS, undefined, { signal: this.signal(signal) });
			} catch {
				if (signal?.aborted) return this.cancel(id);
				break;
			}
		}
		return this.get(id);
	}
	async recover(): Promise<void> {
		for (const job of this.list()) {
			if (this.shutdown.signal.aborted) return;
			await this.reconcile(job.id);
		}
	}
	resume(): void {
		if (this.options.store.owner.kind === "life")
			throw Error(
				"LIFE eager resume is forbidden; runtime must link and reconcile explicitly",
			);
		if (this.poll) return;
		this.poll = (async () => {
			while (!this.shutdown.signal.aborted) {
				try {
					await this.recover();
					this.recoveryError = null;
				} catch {
					this.recoveryError =
						"이미지 작업 복구를 완료하지 못했습니다. 저장소 상태를 확인해주세요.";
				}
				await delay(IMAGE_POLL_MS, undefined, { signal: this.shutdown.signal });
			}
		})().catch((error) => {
			if (!this.shutdown.signal.aborted) throw error;
		});
		// Errors remain observable via close(), without an unhandled rejection.
		void this.poll.catch(() => undefined);
	}
	async flushNotices(): Promise<void> {
		if (this.notices) return this.notices;
		this.notices = Promise.resolve().then(async () => {
			for (const initial of this.list()) {
				let job = initial;
				while (
					terminalImageState(job.state) &&
					job.delivery.kind === "pending"
				) {
					try {
						if (job.artifact) await this.artifacts.verify(job);
						const receipt = await this.completion.complete(job);
						if (receipt.kind !== "pending")
							this.changed(
								this.options.store.acknowledgeCompletion(job, receipt),
							);
					} catch {
						this.changed(
							this.options.store.recordCompletionError(
								job,
								job.owner.kind === "conversation"
									? "이미지 결과를 대화에 전달하지 못했습니다. 저장된 결과로 다시 전달합니다."
									: "이미지 완료 영수증을 저장하지 못했습니다. 원래 결과로 다시 전달합니다.",
							),
						);
					}
					const current = this.get(job.id);
					if (sameImageTerminal(job, current)) break;
					// Recovery can advance this one terminal observation while its old receipt is awaited.
					job = current;
				}
			}
		});
		try {
			await this.notices;
		} finally {
			this.notices = undefined;
		}
	}
	async recoverArtifact(id: string, signal?: AbortSignal): Promise<ImageJob> {
		signal?.throwIfAborted();
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (job.owner.kind !== "life")
				throw Error("Artifact recovery is LIFE-only");
			if (job.state === "completed" && job.artifactRecovery) {
				await this.artifacts.verify(job);
				await this.flushNotices();
				return this.get(id);
			}
			if (
				job.state !== "failed" ||
				!job.resultFilename ||
				!job.endpoint ||
				!job.runtimeVersion
			)
				throw Error(
					"Artifact recovery requires failed known-result provenance",
				);
			const connection = await this.options.client.connect(this.signal(signal));
			if (
				connection.baseUrl !== job.endpoint ||
				connection.version !== job.runtimeVersion
			)
				throw Error("Image runtime changed during artifact recovery");
			await this.artifacts.preflight(job);
			const output = await this.options.client.download(
				{ requestId: id, filename: job.resultFilename },
				this.signal(signal),
			);
			if (!isImageMime(output.mime)) throw Error("Unsupported image format");
			const artifact = await this.artifacts.importOutput(job, output);
			await this.artifacts.verify({ ...job, artifact });
			this.changed(this.options.store.recoverArtifact(id, artifact));
			await this.flushNotices();
			return this.get(id);
		});
	}
	async close(): Promise<void> {
		this.shutdown.abort();
		await Promise.allSettled([...this.active.values()]);
		await this.poll;
		await this.notices;
	}
	private signal(signal?: AbortSignal): AbortSignal {
		return signal
			? AbortSignal.any([signal, this.shutdown.signal])
			: this.shutdown.signal;
	}
	private exclusive(
		id: string,
		run: () => Promise<ImageJob>,
	): Promise<ImageJob> {
		const current = this.active.get(id);
		const promise = (
			current
				? current.then(
						() => undefined,
						() => undefined,
					)
				: Promise.resolve()
		)
			.then(run)
			.finally(() => {
				if (this.active.get(id) === promise) this.active.delete(id);
			});
		this.active.set(id, promise);
		return promise;
	}
}
